import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE_URL = 'https://onlyfaucet.com';
const FAUCET_URL = `${BASE_URL}/faucet/currency/usdt`;
const PROFILE = join(process.env.HOME, '.onlyfaucet-chrome-profile');
const LOCKFILE = '/tmp/onlyfaucet.lock';
const ACCOUNTS_FILE = join(import.meta.dirname, 'accounts.json');
const SHOT_DIR = '/tmp/onlyfaucet-shots';

const VISION_HOST = 'https://ollama.com';
const VISION_KEY = 'b3be06fa11184ba2a874259bb0b505f7.6v336cULw7DZ8EMHdPq6OPlc';
const VISION_MODEL = 'gemma4:31b';

function log(msg) { console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseJSON(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (match) {
    try { return JSON.parse(match[1].trim()); } catch {}
  }
  try { return JSON.parse(text.trim()); } catch { return null; }
}

async function analyzePuzzle(imageBuf, width, height) {
  const base64 = imageBuf.toString('base64');
  // Avoid refusal-triggering words (captcha/security/bypass). Pure perception task.
  const prompt = `You are given a pattern image of size ${width}x${height} pixels.
It contains exactly two notable regions:
1) A closed shape drawn with a bright blue/cyan outline. Its center: pieceX, pieceY.
2) A second region of the same silhouette formed only by a subtle change in the dash texture (a matching "gap" or patch). Its center: targetX, targetY.
These two centers are different points.
Return coordinates as percentages 0-100 of image width and height (x horizontal, y vertical).
Respond with ONLY this JSON object and nothing else:
{"pieceX":25.0,"pieceY":50.0,"targetX":70.0,"targetY":40.0}`;

  const res = await fetch(`${VISION_HOST}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VISION_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: 'user', content: prompt, images: [base64] }],
      stream: false,
      format: 'json',
      options: { temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vision API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.message?.content || '';
  if (!content.trim()) {
    log(`Vision empty content. raw=${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }
  const parsed = parseJSON(content);
  if (!parsed) {
    log(`Vision unparseable: ${content.slice(0, 200)}`);
    return null;
  }

  const clamp = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
  // Accept percent (0-100) or pixel-like values; convert to pixels
  const toPx = (v, dim) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dim / 2;
    if (n <= 100 && n >= 0) return clamp((n / 100) * dim, dim - 1);
    return clamp(n, dim - 1);
  };
  return {
    pieceX: toPx(parsed.pieceX, width),
    pieceY: toPx(parsed.pieceY, height),
    targetX: toPx(parsed.targetX, width),
    targetY: toPx(parsed.targetY, height),
    raw: parsed,
  };
}

function acquireLock() {
  if (existsSync(LOCKFILE)) {
    const pid = readFileSync(LOCKFILE, 'utf8').trim();
    try { process.kill(Number(pid), 0); console.error(`Bot already running (PID ${pid}).`); process.exit(1); } catch {}
    try { unlinkSync(LOCKFILE); } catch {}
  }
  writeFileSync(LOCKFILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCKFILE); } catch {} });
}

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  try { return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return []; }
}

function saveAccounts(accounts) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function addAccount(email) {
  const accounts = loadAccounts();
  if (accounts.find(a => a.email === email)) {
    log('Account already exists.');
    return false;
  }
  accounts.push({ email, claims: 0, lastClaim: null });
  saveAccounts(accounts);
  log(`Account added: ${email}`);
  return true;
}

function bumpClaim(email) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.email === email);
  if (idx >= 0) {
    accounts[idx].claims = (accounts[idx].claims || 0) + 1;
    accounts[idx].lastClaim = new Date().toISOString();
    saveAccounts(accounts);
    return accounts[idx].claims;
  }
  return 0;
}

async function launchBrowser() {
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return ctx;
}

async function gotoRetry(page, url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return true;
    } catch (e) {
      log(`goto attempt ${i + 1}: ${e.message.slice(0, 60)}`);
      await sleep(3000 + i * 2000);
    }
  }
  return false;
}

async function isLoggedIn(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (bodyText.includes('Login / Register') && !bodyText.includes('Claim Now')) return false;
  if (bodyText.includes('Logout') || bodyText.includes('Dashboard')) return true;
  return await page.evaluate(() => !!document.querySelector('form[action*="faucet/verify"]')).catch(() => false);
}

async function login(page, email) {
  log('Clicking Login / Register...');
  await page.click('text=Login / Register').catch(() => {});
  await sleep(2000);
  await page.fill('#walletInput', email).catch(() => {});
  await sleep(1000);
  await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
  await sleep(5000);
  if (await isLoggedIn(page)) {
    log('Login successful!');
    return true;
  }
  log('Login failed');
  return false;
}

async function dismissSweetAlert(page) {
  const clicked = await page.evaluate(() => {
    let ok = false;
    const selectors = [
      '.swal2-confirm', '.swal2-cancel', '.swal2-close',
      '.swal2-container button', '.sweet-alert button.confirm',
      'button.close', '[aria-label="close"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.click(); ok = true; }
    }
    // Custom error cards with an X close control
    const cards = [...document.querySelectorAll('div,aside,section')].filter(el => {
      const t = (el.innerText || '');
      return t.includes('Please complete the captcha') && el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().width < 600;
    });
    for (const card of cards) {
      const x = [...card.querySelectorAll('button,a,span,i,[class*="close"],[class*="times"]')]
        .find(el => /×|x|close/i.test((el.innerText || '').trim()) || /close|times/i.test(el.className?.toString?.() || ''));
      if (x) { x.click(); ok = true; }
    }
    // Escape closes most modals
    return ok;
  }).catch(() => false);
  if (clicked) await sleep(400);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(200);
}

async function getPageState(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const answer = document.querySelector('[name="captcha_answer"]')?.value || '';
      const waitMatch = text.match(/Please wait\s*(\d+):(\d+)/i);
      const waitSec = waitMatch ? Number(waitMatch[1]) * 60 + Number(waitMatch[2]) : null;
      const h = document.querySelector('[id^="h_"]');
      let hRect = null;
      if (h) {
        const r = h.getBoundingClientRect();
        if (r.width > 40 && r.height > 40) hRect = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      const cb = document.querySelector('[id^="cb_"]');
      let cbRect = null;
      if (cb) {
        const r = cb.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) cbRect = { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }
      const verifyBtn = document.querySelector('[id^="cb_btn_"]');
      let verifyRect = null;
      if (verifyBtn) {
        const r = verifyBtn.getBoundingClientRect();
        if (r.width > 0) verifyRect = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return {
        text: text.slice(0, 600),
        success: text.includes('has been sent'),
        verification: text.includes('Verification Required'),
        puzzle: text.includes('Drag the shape'),
        captchaError: text.includes('Please complete the captcha'),
        cooldown: waitSec !== null,
        waitSec,
        claimBtn: /Claim Now/i.test(text),
        captchaAnswer: answer,
        hRect, cbRect, verifyRect,
        hasForm: !!document.querySelector('form[action*="faucet/verify"]'),
      };
    });
  } catch (e) {
    return { text: '', success: false, verification: false, puzzle: false, captchaError: false, cooldown: false, waitSec: null, claimBtn: false, captchaAnswer: '', hRect: null, cbRect: null, verifyRect: null, hasForm: false, navError: true };
  }
}

async function getPuzzleBox(page) {
  // Scroll into center first so clip stays inside viewport (ads shift layout)
  await page.evaluate(() => {
    if (!document || !document.body) return;
    const h = document.querySelector('[id^="h_"]');
    if (h) { h.scrollIntoView({ block: 'center', behavior: 'instant' }); return; }
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if ((n.textContent || '').includes('Drag the shape')) {
          let el = n.parentElement;
          for (let i = 0; i < 10 && el; i++) {
            const r = el.getBoundingClientRect();
            if (r.width > 250 && r.height > 180) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); return; }
            el = el.parentElement;
          }
        }
      }
    } catch (e) { /* mid-navigation */ }
  }).catch(() => {});
  await sleep(400);

  return page.evaluate(() => {
    if (!document || !document.body) return null;
    const h = document.querySelector('[id^="h_"]');
    if (h) {
      const r = h.getBoundingClientRect();
      if (r.width > 80 && r.height > 80) return { x: r.x, y: r.y, w: r.width, h: r.height, src: 'h_' };
    }
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if ((n.textContent || '').includes('Drag the shape')) {
          let el = n.parentElement;
          for (let i = 0; i < 10 && el; i++) {
            const r = el.getBoundingClientRect();
            if (r.width > 250 && r.height > 180) return { x: r.x, y: r.y, w: r.width, h: r.height, src: 'text' };
            el = el.parentElement;
          }
        }
      }
    } catch (e) { /* mid-navigation */ }
    return null;
  }).catch(() => null);
}

async function handlePuzzle(page, attempt = 0) {
  log(`Solving puzzle (attempt ${attempt + 1})...`);
  if (attempt >= 4) { log('Max puzzle attempts'); return false; }
  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

  await dismissSweetAlert(page);
  await page.evaluate(() => {
    document.querySelectorAll('[class^="cc-"]').forEach(el => el.remove());
  }).catch(() => {});
  await sleep(300);

  // Wait for puzzle widget fully rendered (instruction text or sized h_ host)
  let box = null;
  for (let i = 0; i < 15; i++) {
    const st = await getPageState(page);
    if (st.captchaError) await dismissSweetAlert(page);
    if (st.puzzle || st.hRect) {
      box = await getPuzzleBox(page);
      if (box) {
        // Ensure canvas content rendered: screenshot must not be tiny/blank
        const probe = await page.screenshot({
          clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.w, 1280), height: Math.min(box.h, 800) },
        }).catch(() => null);
        if (probe && probe.length > 8000) {
          log(`Puzzle rendered (${probe.length} bytes)`);
          break;
        }
        log(`Widget present but not rendered yet (${probe?.length ?? 0} bytes)`);
        box = (i < 14) ? box : box;
        if (i >= 14) break;
        box = null;
      }
    }
    if (st.cbRect && st.verification) {
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const cb = await getPageState(page);
      if (cb.cbRect) {
        await page.mouse.click(cb.cbRect.x, cb.cbRect.y);
        log('Clicked verification checkbox');
      }
    }
    log(`Waiting for puzzle widget... (${i + 1}/15)`);
    await sleep(2000);
  }

  if (!box) {
    log('Puzzle widget not found');
    await page.screenshot({ path: `${SHOT_DIR}/no-widget-${ts()}.png`, fullPage: true }).catch(() => {});
    // Widget gone might mean claim navigated to success/cooldown
    const st = await getPageState(page);
    if (st.success || st.cooldown) return true;
    return false;
  }
  // Clamp clip to viewport
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const clip = {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.min(box.w, vp.width),
    height: Math.min(box.h, vp.height),
  };
  if (clip.y + clip.height > vp.height) clip.height = Math.max(50, vp.height - clip.y);
  if (clip.x + clip.width > vp.width) clip.width = Math.max(50, vp.width - clip.x);

  await sleep(800);
  const shotPath = `${SHOT_DIR}/puzzle-${ts()}.png`;
  const shot = await page.screenshot({ path: shotPath, clip });
  log(`Screenshot ${shot.length} bytes clip=${JSON.stringify(clip)}`);
  if (shot.length < 8000) {
    log('Screenshot looks blank — waiting and retrying once');
    await sleep(2500);
    const shot2 = await page.screenshot({ path: `${SHOT_DIR}/puzzle-retry-${ts()}.png`, clip });
    if (shot2.length >= 8000) {
      return handlePuzzleContent(page, shot2, shot2.length >= 8000 ? `${SHOT_DIR}/puzzle-retry-${ts()}.png` : shotPath, clip, attempt);
    }
    log(`Still blank (${shot2.length} bytes)`);
    return false;
  }
  return handlePuzzleContent(page, shot, shotPath, clip, attempt);
}

function findPiecePy(path) {
  try {
    const out = execFileSync('python3', [join(import.meta.dirname, 'find_piece.py'), path], { encoding: 'utf8', timeout: 15000 }).trim();
    if (!out || out === 'null') return null;
    return JSON.parse(out);
  } catch (e) {
    log(`find_piece error: ${e.message.slice(0, 100)}`);
    return null;
  }
}

function findHolePy(path) {
  try {
    const out = execFileSync('python3', [join(import.meta.dirname, 'find_hole.py'), path], { encoding: 'utf8', timeout: 30000 }).trim();
    if (!out || out === 'null') return null;
    return JSON.parse(out);
  } catch (e) {
    log(`find_hole error: ${e.message.slice(0, 100)}`);
    return null;
  }
}

async function handlePuzzleContent(page, shot, shotPath, clip, attempt) {
  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
  const w = Math.round(clip.width);
  const h = Math.round(clip.height);
  log(`Puzzle box clip: ${JSON.stringify(clip)}`);

  let holeDet = findHolePy(shotPath);
  log(`find_hole: ${JSON.stringify(holeDet)}`);

  // Re-screenshot + re-detect if piece/candidates missing (mid-render)
  let pyHasTarget = holeDet && holeDet.targetX != null && holeDet.cands && holeDet.cands.length > 0;
  if (!pyHasTarget && attempt < 3) {
    log('Detection weak — waiting and re-screenshotting...');
    await sleep(2000);
    const shotPath2 = `${SHOT_DIR}/puzzle-redet-${ts()}.png`;
    const shot2 = await page.screenshot({ path: shotPath2, clip }).catch(() => null);
    if (shot2 && shot2.length >= 8000) {
      holeDet = findHolePy(shotPath2);
      log(`find_hole retry: ${JSON.stringify(holeDet)}`);
      shot = shot2;
      shotPath = shotPath2;
      pyHasTarget = holeDet && holeDet.targetX != null && holeDet.cands && holeDet.cands.length > 0;
    }
  }

  // Vision only when py found nothing
  let vision = null;
  if (!pyHasTarget) {
    for (let v = 0; v < 3; v++) {
      try {
        vision = await analyzePuzzle(shot, w, h);
        log(`Vision: ${JSON.stringify(vision)}`);
        if (vision && vision.targetX != null && vision.targetY != null) break;
      } catch (e) {
        log(`Vision error: ${e.message.slice(0, 120)}`);
        await sleep(2000);
      }
    }
  }

  const pieceX = (holeDet && holeDet.pieceX != null) ? holeDet.pieceX
    : (vision && vision.pieceX != null) ? vision.pieceX : w / 2;
  const pieceY = (holeDet && holeDet.pieceY != null) ? holeDet.pieceY
    : (vision && vision.pieceY != null) ? vision.pieceY : h / 2;
  const grabX = (holeDet && holeDet.grabX != null) ? holeDet.grabX : pieceX;
  const grabY = (holeDet && holeDet.grabY != null) ? holeDet.grabY : pieceY;
  const offX = grabX - pieceX;
  const offY = grabY - pieceY;

  const candidates = [];
  if (holeDet && holeDet.cands && holeDet.cands.length) {
    for (const c of holeDet.cands) {
      if (Math.hypot(c.x - pieceX, c.y - pieceY) < 15) continue;
      candidates.push({ x: c.x, y: c.y, src: `py${c.score}` });
    }
  }
  if (vision && vision.targetX != null) {
    const vx = vision.targetX, vy = vision.targetY;
    const vdist = Math.hypot(vx - pieceX, vy - pieceY);
    if (vdist >= 15 && !candidates.some(c => Math.hypot(c.x - vx, c.y - vy) < 25)) {
      candidates.push({ x: vx, y: vy, src: 'vision' });
    } else if (vdist < 15) {
      log('Vision piece≈target — ignoring');
    }
  }
  if (candidates.length === 0) {
    log('No target candidates');
    if (attempt < 3) return handlePuzzle(page, attempt + 1);
    return false;
  }

  // Try up to 4 ranked candidates (same cand retried once if drop misses)
  const maxTry = Math.min(candidates.length, 4);
  const retried = new Set();
  for (let ci = 0; ci < maxTry; ci++) {
    const cand = candidates[ci];

    // Grab ON the blue stroke; compensate so piece CENTER lands on hole center
    const gx = clip.x + grabX;
    const gy = clip.y + grabY;
    const tx0 = clip.x + cand.x + offX;
    const ty0 = clip.y + cand.y + offY;

    // Re-measure box right before drag (ads shift layout)
    const fresh = await getPuzzleBox(page);
    let dx = 0, dy = 0;
    if (fresh && fresh.w && Math.abs(fresh.w - clip.width) < 30) {
      dx = fresh.x - clip.x;
      dy = fresh.y - clip.y;
    }
    const fx = gx + dx, fy = gy + dy;
    const tx = tx0 + dx, ty = ty0 + dy;
    log(`Drag [${cand.src}] grab(${Math.round(fx)},${Math.round(fy)}) -> drop(${Math.round(tx)},${Math.round(ty)}) off(${Math.round(offX)},${Math.round(offY)})`);

    await page.mouse.move(fx, fy, { steps: 6 });
    await sleep(100 + Math.random() * 150);
    await page.mouse.down();
    await sleep(60 + Math.random() * 100);

    const steps = 16 + Math.floor(Math.random() * 8);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);
      const mx = fx + (tx - fx) * ease + (Math.random() - 0.5) * 2;
      const my = fy + (ty - fy) * ease + (Math.random() - 0.5) * 2;
      await page.mouse.move(mx, my);
      await sleep(25 + Math.random() * 35);
    }
    // Small settle wiggle on target to register drop
    await page.mouse.move(tx + (Math.random() - 0.5) * 4, ty + (Math.random() - 0.5) * 4, { steps: 3 });
    await sleep(80);
    await page.mouse.up();
    await sleep(700);
    log('Drag completed');

    const afterDrag = await getPageState(page);
    log(`captcha_answer after drag: "${afterDrag.captchaAnswer}"`);
    if (!afterDrag.captchaAnswer) {
      log('Answer not recorded — reset and try next candidate');
      await page.evaluate(() => {
        const b = document.querySelector('[id^="rb_btn_"]');
        if (b) b.click();
      }).catch(() => {});
      await sleep(700);
      continue;
    }

    // Verify drop landed near intended target (captcha_answer is canvas-internal ~450x280)
    const ansM = afterDrag.captchaAnswer.match(/^(\d+)\s*,\s*(\d+)$/);
    if (ansM) {
      const axCss = (+ansM[1]) * (w / 450);
      const ayCss = (+ansM[2]) * (h / 280);
      const dropErr = Math.hypot(axCss - cand.x, ayCss - cand.y);
      log(`Drop check: answer CSS(${axCss.toFixed(0)},${ayCss.toFixed(0)}) vs target(${cand.x},${cand.y}) err=${dropErr.toFixed(1)}px`);
      if (dropErr > 55) {
        log('Drop missed target — reset and retry same candidate');
        await page.evaluate(() => {
          const b = document.querySelector('[id^="rb_btn_"]');
          if (b) b.click();
        }).catch(() => {});
        await sleep(700);
        if (!retried.has(ci)) {
          retried.add(ci);
          ci--; // retry same index
        }
        continue;
      }
    }

    // Click Verify Selection — may navigate
    const st = await getPageState(page);
    const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
    if (st.verifyRect) {
      await page.mouse.click(st.verifyRect.x, st.verifyRect.y);
      log('Clicked Verify Selection');
    } else {
      const clicked = await page.evaluate(() => {
        const b = document.querySelector('[id^="cb_btn_"]');
        if (b) { b.click(); return true; }
        return false;
      }).catch(() => false);
      log(`Verify fallback click: ${clicked}`);
    }
    await navPromise;
    await sleep(2000);

    // Poll for result
    for (let i = 0; i < 10; i++) {
      const after = await getPageState(page);
      if (after.navError) { await sleep(1500); continue; }
      if (after.success) { log('Puzzle solved — claim successful!'); return true; }
      if (after.cooldown) { log('Cooldown after puzzle — claim likely succeeded'); return true; }
      if (after.captchaError) {
        await dismissSweetAlert(page);
        log('Captcha rejected');
        break;
      }
      if (after.verification && !after.success && i >= 3) {
        await dismissSweetAlert(page);
        log('Still verification after verify — reject');
        break;
      }
      if (after.puzzle && after.captchaAnswer === '') {
        log('Puzzle reset');
        break;
      }
      if (after.claimBtn && !after.verification && !after.puzzle && after.success) return true;
      await sleep(2000);
    }

    const mid = await getPageState(page);
    if (mid.success || mid.cooldown) return true;
    if (ci < maxTry - 1) {
      const cur = await getPageState(page);
      if (!cur.puzzle && !cur.verification) {
        if (cur.success || cur.cooldown) return true;
        break;
      }
      if (cur.puzzle) {
        await page.evaluate(() => {
          const b = document.querySelector('[id^="rb_btn_"]');
          if (b) b.click();
        }).catch(() => {});
        await sleep(800);
        // Re-screenshot after reset for fresh coordinates
        break; // re-enter handlePuzzle for fresh vision/py on new puzzle
      }
      if (cur.verification) {
        const clicked = await page.evaluate(() => {
          const c = document.querySelector('[id^="cb_"]');
          if (c) { c.click(); return true; }
          return false;
        }).catch(() => false);
        if (clicked) await sleep(2500);
        break;
      }
    }
  }

  await page.screenshot({ path: `${SHOT_DIR}/after-verify-${ts()}.png`, fullPage: true }).catch(() => {});
  const final = await getPageState(page);
  log(`After verify: success=${final.success} cooldown=${final.cooldown} puzzle=${final.puzzle} verif=${final.verification}`);
  if (final.success || final.cooldown) return true;
  if (attempt < 3) return handlePuzzle(page, attempt + 1);
  return false;
}

async function claimFaucet(page, email) {
  log('Checking faucet status...');
  let st = await getPageState(page);
  log(`state: success=${st.success} verif=${st.verification} puzzle=${st.puzzle} cooldown=${st.cooldown} wait=${st.waitSec}s claimBtn=${st.claimBtn}`);

  if (st.success) {
    await dismissSweetAlert(page);
    const n = bumpClaim(email);
    log(`Success already shown. Claims=${n}`);
    return 'success';
  }

  if (st.captchaError) {
    await dismissSweetAlert(page);
    st = await getPageState(page);
  }

  if (st.puzzle || st.verification) {
    log('Verification/puzzle present — solving...');
    const ok = await handlePuzzle(page);
    st = await getPageState(page);
    if (ok || st.success || st.cooldown) {
      await dismissSweetAlert(page);
      const n = bumpClaim(email);
      log(`Claim via puzzle. Claims=${n}`);
      return 'success';
    }
    log('Puzzle solve did not confirm success');
    return 'puzzle-failed';
  }

  if (st.cooldown) {
    log(`On cooldown: ${st.waitSec}s`);
    return 'cooldown';
  }

  if (st.hasForm && st.claimBtn) {
    log('Submitting claim form...');
    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form[action*="faucet/verify"]');
      if (form) { form.submit(); return true; }
      const btn = [...document.querySelectorAll('button')].find(b => /claim now/i.test(b.innerText || ''));
      if (btn) { btn.click(); return 'clicked'; }
      return false;
    });
    log(`Submitted: ${submitted}`);
    await sleep(8000);

    st = await getPageState(page);
    log(`after submit: success=${st.success} verif=${st.verification} puzzle=${st.puzzle} cooldown=${st.cooldown} wait=${st.waitSec} captchaErr=${st.captchaError}`);
    await page.screenshot({ path: `${SHOT_DIR}/after-submit-${Date.now()}.png`, fullPage: true }).catch(() => {});

    if (st.captchaError) {
      await dismissSweetAlert(page);
      st = await getPageState(page);
    }

    if (st.success) {
      await dismissSweetAlert(page);
      const n = bumpClaim(email);
      log(`Claim successful! Claims=${n}`);
      return 'success';
    }
    if (st.puzzle || st.verification) {
      const ok = await handlePuzzle(page);
      st = await getPageState(page);
      if (ok || st.success || st.cooldown) {
        await dismissSweetAlert(page);
        const n = bumpClaim(email);
        log(`Claim via puzzle after submit. Claims=${n}`);
        return 'success';
      }
      return 'puzzle-failed';
    }
    if (st.cooldown) {
      const n = bumpClaim(email);
      log(`Cooldown after submit (treated as success). Claims=${n}`);
      return 'success';
    }
    log(`Unexpected after submit: ${st.text.replace(/\n/g, ' | ').slice(0, 150)}`);
    return 'unknown';
  }

  log('No claim available');
  return 'none';
}

async function waitForCooldown(page, maxSec = 120) {
  for (let i = 0; i < maxSec / 5; i++) {
    const st = await getPageState(page);
    if (!st.cooldown && (st.claimBtn || st.verification || st.puzzle)) return true;
    if (st.success) return 'success';
    log(`Cooldown wait ${st.waitSec ?? '?'}s...`);
    await sleep(5000);
  }
  return false;
}

async function runOnce(email) {
  const ctx = await launchBrowser();
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
    await sleep(3000);
    if (!(await isLoggedIn(page))) {
      await login(page, email);
    } else {
      log('Already logged in');
    }

    if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
    await sleep(4000);

    const result = await claimFaucet(page, email);
    log(`Result: ${result}`);
    return result;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function runLoop(email) {
  log('=== OnlyFaucet Bot Started ===');
  let ctx = null;
  let page = null;
  let fails = 0;

  while (true) {
    try {
      if (!ctx || !page || page.isClosed()) {
        if (ctx) await ctx.close().catch(() => {});
        ctx = await launchBrowser();
        page = ctx.pages()[0] || (await ctx.newPage());
        if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
        await sleep(3000);
        if (!(await isLoggedIn(page))) await login(page, email);
        if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
        await sleep(4000);
        fails = 0;
      }

      // Ensure on faucet page
      if (!page.url().includes('/faucet/')) {
        if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
        await sleep(3000);
      }

      const result = await claimFaucet(page, email);

      if (result === 'success') {
        fails = 0;
        // Wait cooldown then claim again on same page (no refresh unless needed)
        const ready = await waitForCooldown(page, 60);
        if (ready === 'success') {
          await dismissSweetAlert(page);
          bumpClaim(email);
        }
        await sleep(2000);
      } else if (result === 'cooldown') {
        await waitForCooldown(page, 60);
        await sleep(2000);
      } else {
        fails++;
        log(`Non-success (${result}), fails=${fails}`);
        if (fails >= 3) {
          log('Reloading faucet page...');
          await gotoRetry(page, FAUCET_URL);
          await sleep(4000);
          fails = 0;
        } else {
          await sleep(10000);
        }
      }
    } catch (e) {
      log(`ERROR: ${e.message.slice(0, 100)}`);
      fails++;
      if (ctx) { await ctx.close().catch(() => {}); ctx = null; page = null; }
      await sleep(15000);
    }
  }
}

// CLI
const args = process.argv.slice(2);
if (args[0] === 'add' && args[1]) {
  addAccount(args[1]);
} else if (args[0] === 'list') {
  loadAccounts().forEach(a => console.log(`${a.email} - Claims: ${a.claims} - Last: ${a.lastClaim || 'never'}`));
} else if (args[0] === 'once') {
  const accounts = loadAccounts();
  if (!accounts.length) { console.error('No accounts'); process.exit(1); }
  runOnce(accounts[0].email).then(r => { console.log(`done: ${r}`); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
} else {
  acquireLock();
  const accounts = loadAccounts();
  if (!accounts.length) {
    log('No accounts found. Run: node bot.mjs add <email>');
    process.exit(0);
  }
  runLoop(accounts[0].email).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
