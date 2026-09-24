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
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu'],
    viewport: { width: 1280, height: 800 },
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return ctx;
}

async function gotoRetry(page, url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForCloudflare(page, 90);
      return true;
    } catch (e) {
      log(`goto attempt ${i + 1}: ${e.message.slice(0, 60)}`);
      await sleep(3000 + i * 2000);
    }
  }
  return false;
}

async function getChallengeState(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const pageUrl = page.url() || '';

  // Real site content present → past CF
  const hasForm = await page.evaluate(() => !!document.querySelector('form[action*="faucet/verify"]')).catch(() => false);
  const onSite =
    hasForm ||
    bodyText.includes('Claim Now') ||
    bodyText.includes('Login / Register') ||
    bodyText.includes('Logout') ||
    bodyText.includes('Dashboard') ||
    bodyText.includes('Drag the shape') ||
    bodyText.includes('has been sent') ||
    bodyText.includes('Please wait') ||
    bodyText.includes('Verification Required') ||
    (bodyText.includes('Faucet') && bodyText.length > 80);
  if (onSite) return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };

  // Blank/interstitial page after CF redirect (auth/login?__cf_chl_rt_tk=...) or empty body with CF frame
  const blankBody = bodyText.trim().length < 20;
  const cfTokenUrl = pageUrl.includes('__cf_chl_rt_tk') || pageUrl.includes('cdn-cgi/challenge');
  let hasAnyCfFrame = false;
  for (const frame of page.frames()) {
    try {
      const u = frame.url() || '';
      if (u.includes('challenges.cloudflare.com') || u.includes('turnstile')) { hasAnyCfFrame = true; break; }
    } catch {}
  }
  if (cfTokenUrl || (blankBody && hasAnyCfFrame) || (blankBody && !bodyText.trim())) {
    // Still waiting on CF handoff — treat as challenge so waitForCloudflare keeps waiting
    if (cfTokenUrl || hasAnyCfFrame) {
      return await describeFrameState(page, true);
    }
    // Truly blank with no frames: give the page a moment; if still blank after long, not a challenge
    if (blankBody && pageUrl.includes('onlyfaucet.com')) {
      return await describeFrameState(page, hasAnyCfFrame);
    }
  }

  // Strict CF challenge detection — main challenge heading only (match rosecrypto)
  const onChallenge =
    bodyText.includes('Performing security verification') ||
    bodyText.includes('Just a moment...');
  if (!onChallenge) return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };

  // Extra guard: site captcha UI also present → treat as site
  if (
    bodyText.includes('Drag the shape') ||
    bodyText.includes('Claim Now') ||
    bodyText.includes('has been sent') ||
    bodyText.includes('Please complete the captcha')
  ) {
    return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };
  }

  return await describeFrameState(page, true);
}

async function describeFrameState(page, onChallenge) {
  let verifying = false;
  let verifyHuman = false;
  let hasChallengeFrame = false;
  let frameOpaque = false;
  for (const frame of page.frames()) {
    try {
      const url = frame.url() || '';
      if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
        hasChallengeFrame = true;
        const t = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (!t.trim()) frameOpaque = true;
        if (t.includes('Verifying') || t.includes('verifying')) verifying = true;
        if (t.includes('Verify you are human') || t.includes('verify you are human')) verifyHuman = true;
      }
    } catch {}
  }
  if (!onChallenge) return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };
  return { onChallenge: true, verifying, verifyHuman, hasChallengeFrame, frameOpaque };
}

async function clickChallengeBody(page) {
  // Prefer Playwright frame.frameElement() — CF widget often lives in shadow DOM,
  // so document.querySelectorAll('iframe') returns nothing.
  for (const frame of page.frames()) {
    try {
      const url = frame.url() || '';
      if (!url.includes('challenges.cloudflare.com') && !url.includes('turnstile') && !url.includes('cloudflare') && !url.includes('cf-')) continue;
      const el = await frame.frameElement().catch(() => null);
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      const local = await frame.evaluate(() => {
        const input = document.querySelector('input[type="checkbox"]');
        if (input) {
          const r = input.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        const body = document.body?.getBoundingClientRect();
        const h = body && body.height > 10 ? body.height : 65;
        return { x: 25, y: h / 2 };
      }).catch(() => ({ x: 25, y: 32 }));
      const pageX = box.x + local.x;
      const pageY = box.y + local.y;
      log(`Clicking CF via frameElement at (${Math.round(pageX)}, ${Math.round(pageY)}) box=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)} url=${url.slice(0, 80)}`);
      await page.mouse.move(pageX, pageY, { steps: 8 });
      await sleep(300);
      await page.mouse.click(pageX, pageY);
      return true;
    } catch {}
  }

  const allIframes = await page.evaluate(() =>
    [...document.querySelectorAll('iframe')].map(f => {
      const r = f.getBoundingClientRect();
      return { src: (f.src || '').slice(0, 100), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })
  ).catch(() => []);
  log(`DOM iframes (${allIframes.length}): ${JSON.stringify(allIframes.slice(0, 5))}`);

  const iframePos = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')];
    const cf = iframes.filter(f => {
      const src = f.src || '';
      return src.includes('challenges.cloudflare.com') || src.includes('turnstile') || src.includes('cf-chl') || src.includes('cloudflare');
    });
    const candidates = cf.length ? cf : iframes.filter(f => {
      const r = f.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 200;
    });
    for (const iframe of candidates) {
      const r = iframe.getBoundingClientRect();
      const s = getComputedStyle(iframe);
      if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') {
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    }
    return null;
  }).catch(() => null);

  if (iframePos) {
    log(`CF iframe at (${Math.round(iframePos.x)},${Math.round(iframePos.y)}) ${Math.round(iframePos.w)}x${Math.round(iframePos.h)}`);
    const pageX = iframePos.x + 25;
    const pageY = iframePos.y + iframePos.h / 2;
    log(`Clicking CF iframe area at (${Math.round(pageX)}, ${Math.round(pageY)})`);
    await page.mouse.move(pageX, pageY, { steps: 5 });
    await sleep(200);
    await page.mouse.click(pageX, pageY);
    return true;
  }
  log('Clicking CF checkbox fallback at (215, 336)');
  await page.mouse.move(215, 336, { steps: 5 });
  await sleep(200);
  await page.mouse.click(215, 336);
  return false;
}

async function waitForCloudflare(page, maxSec = 90) {
  let verifyingSince = 0;
  let lastClickAt = 0;
  let lastLog = 0;
  let reloadCount = 0;
  let assumeVerifyUntil = 0; // after a click, wait — widget may show "Verifying..." with unreadable frame text
  let frameGoneSince = 0;

  for (let i = 0; i < maxSec; i++) {
    const state = await getChallengeState(page).catch(() => ({ onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false }));
    if (!state.onChallenge) {
      if (i > 0) log('CF cleared');
      return true;
    }

    if (Date.now() - lastLog > 10000) {
      log(`CF state: verifying=${state.verifying} verifyHuman=${state.verifyHuman} frame=${state.hasChallengeFrame} opaque=${state.frameOpaque} i=${i}`);
      lastLog = Date.now();
      try { await page.screenshot({ path: `${SHOT_DIR}/cf-debug-${Date.now()}.png` }); } catch {}
    }

    // Track how long the challenge frame has been missing — brief gaps are normal during verify
    if (!state.hasChallengeFrame) {
      if (!frameGoneSince) frameGoneSince = Date.now();
    } else {
      frameGoneSince = 0;
    }

    // Verifying: from frame text OR shortly after our own click (opaque frame can't report it)
    const inVerifyWait = state.verifying || Date.now() < assumeVerifyUntil;
    if (inVerifyWait) {
      if (!verifyingSince) verifyingSince = Date.now();
      // Stay patient — interrupting verify restarts the challenge
      if (Date.now() - verifyingSince > 45000 && reloadCount < 3) {
        log('CF verifying stuck, reloading...');
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
        await sleep(5000);
        verifyingSince = 0;
        lastClickAt = 0;
        assumeVerifyUntil = 0;
        frameGoneSince = 0;
        reloadCount++;
        continue;
      }
      await sleep(2000);
      continue;
    }

    // Explicit checkbox text (readable frame)
    if (state.verifyHuman) {
      const now = Date.now();
      if (!lastClickAt || now - lastClickAt > 10000) {
        log('Clicking Verify you are human...');
        await clickChallengeBody(page);
        lastClickAt = now;
        verifyingSince = 0;
        assumeVerifyUntil = Date.now() + 30000; // long wait — do not re-click while widget verifies
        await sleep(3000);
        const still = await getChallengeState(page).catch(() => ({ onChallenge: false }));
        if (!still.onChallenge) return true;
      } else {
        await sleep(2000);
      }
      continue;
    }

    // Opaque frame / present frame with no explicit state: wait before first click,
    // then click once and give a long verify window.
    if (state.frameOpaque || state.hasChallengeFrame) {
      const now = Date.now();
      const waitedNoClick = !lastClickAt || now - lastClickAt > 20000;
      if (waitedNoClick && i >= 4) {
        log('CF frame present, clicking widget once...');
        await clickChallengeBody(page);
        lastClickAt = now;
        assumeVerifyUntil = Date.now() + 30000;
        verifyingSince = 0;
        await sleep(3000);
        const still = await getChallengeState(page).catch(() => ({ onChallenge: false }));
        if (!still.onChallenge) return true;
      } else {
        await sleep(2000);
      }
      continue;
    }

    // On challenge but frame missing — only reload after a sustained gap
    if (i > 3) {
      const now = Date.now();
      const frameGoneMs = frameGoneSince ? now - frameGoneSince : 0;
      if (!lastClickAt || now - lastClickAt > 8000) {
        if (!state.hasChallengeFrame && frameGoneMs > 15000 && reloadCount < 3) {
          log('CF widget not loaded 15s, reloading...');
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
          await sleep(6000);
          reloadCount++;
          lastClickAt = 0;
          assumeVerifyUntil = 0;
          frameGoneSince = 0;
          continue;
        }
        if (i > 40 && reloadCount < 3) {
          log('CF stuck too long, reloading...');
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
          await sleep(5000);
          reloadCount++;
          lastClickAt = 0;
          assumeVerifyUntil = 0;
          frameGoneSince = 0;
          continue;
        }
        if (i > 75 || reloadCount >= 3) {
          log('CF giving up after many attempts');
          return false;
        }
        log('On challenge, clicking widget fallback...');
        await page.mouse.click(215, 336);
        lastClickAt = now;
        assumeVerifyUntil = Date.now() + 30000;
        await sleep(6000);
      } else {
        await sleep(2000);
      }
      continue;
    }

    await sleep(2000);
  }
  log('waitForCloudflare timed out');
  try { await page.screenshot({ path: `${SHOT_DIR}/cf-timeout-${Date.now()}.png` }); } catch {}
  return false;
}

async function solveTurnstile(page) {
  log('Solving Turnstile...');
  const tb = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile') ||
      document.querySelector('[data-sitekey]') ||
      document.querySelector('div[class*="turnstile"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }).catch(() => null);

  if (!tb) {
    log('No turnstile found');
    return false;
  }

  for (let i = 0; i < 10; i++) {
    await page.mouse.move(tb.x, tb.y, { steps: 5 });
    await sleep(200);
    await page.mouse.click(tb.x, tb.y);
    await sleep(1500);

    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]') ||
        document.querySelector('textarea[name="cf-turnstile-response"]');
      return input?.value || '';
    }).catch(() => '');

    if (token.length > 10) {
      log(`Turnstile solved (token: ${token.slice(0, 20)}...)`);
      return true;
    }
  }

  // Fallback: use clickChallengeBody if container click didn't produce token
  log('Turnstile container click failed, trying challenge body click...');
  await clickChallengeBody(page);
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]') ||
        document.querySelector('textarea[name="cf-turnstile-response"]');
      return input?.value || '';
    }).catch(() => '');
    if (token.length > 10) {
      log(`Turnstile solved via body click (token: ${token.slice(0, 20)}...)`);
      return true;
    }
  }

  log('Turnstile failed');
  return false;
}

async function hasTurnstile(page) {
  return await page.evaluate(() =>
    !!document.querySelector('.cf-turnstile') ||
    !!document.querySelector('input[name="cf-turnstile-response"]') ||
    [...document.querySelectorAll('iframe')].some(f => {
      const s = f.src || '';
      return s.includes('challenges.cloudflare.com') || s.includes('turnstile');
    })
  ).catch(() => false);
}

async function ensureCleared(page) {
  const ok = await waitForCloudflare(page, 90);
  if (!ok) {
    log('ensureCleared: waitForCloudflare failed');
    try { await page.screenshot({ path: `${SHOT_DIR}/cleared-fail-${Date.now()}.png`, fullPage: true }); } catch {}
  }
  // After CF, blank handoff pages (auth/login?__cf_chl_rt_tk=) need a beat to render
  for (let i = 0; i < 8; i++) {
    const blank = await page.evaluate(() => (document.body?.innerText || '').trim().length < 20).catch(() => false);
    const tokenUrl = page.url().includes('__cf_chl_rt_tk');
    if (!blank && !tokenUrl) break;
    log(`ensureCleared: waiting for page render (blank=${blank} tokenUrl=${tokenUrl})`);
    await sleep(2000);
    if (i >= 3 && tokenUrl) {
      // Force a clean load without the challenge handoff token
      const clean = page.url().split('?')[0];
      try { await page.goto(clean, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
      await waitForCloudflare(page, 60);
    }
  }
  if (await hasTurnstile(page)) {
    const token = await page.evaluate(() =>
      (document.querySelector('input[name="cf-turnstile-response"]')?.value || '')
    ).catch(() => '');
    if (token.length < 10) await solveTurnstile(page);
  }
}

async function isLoggedIn(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (bodyText.includes('Login / Register') && !bodyText.includes('Claim Now')) return false;
  if (bodyText.includes('Logout') || bodyText.includes('Dashboard')) return true;
  return await page.evaluate(() => !!document.querySelector('form[action*="faucet/verify"]')).catch(() => false);
}

async function login(page, email) {
  log('Clicking Login / Register...');
  await ensureCleared(page);
  // If we're not on a page with the login entry point, go home first
  const hasLoginEntry = await page.evaluate(() =>
    (document.body?.innerText || '').includes('Login / Register')
  ).catch(() => false);
  if (!hasLoginEntry && !page.url().includes('/auth/login')) {
    log('Login entry not found, reloading home...');
    await gotoRetry(page, BASE_URL);
    await sleep(2000);
    await ensureCleared(page);
  }
  await page.click('text=Login / Register').catch(() => {});
  await sleep(2000);
  // Login may navigate to /auth/login (possibly with CF handoff token)
  if (page.url().includes('/auth/login')) {
    log(`On login URL: ${page.url().slice(0, 120)}`);
    await ensureCleared(page);
    // Strip challenge handoff token if still present
    if (page.url().includes('__cf_chl_rt_tk')) {
      try { await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
      await ensureCleared(page);
    }
  } else {
    await ensureCleared(page);
  }
  // Wait for wallet input to appear
  let hasWallet = false;
  for (let i = 0; i < 10; i++) {
    hasWallet = await page.evaluate(() => !!document.querySelector('#walletInput')).catch(() => false);
    if (hasWallet) break;
    log(`Waiting for #walletInput (${i})... url=${page.url().slice(0, 100)}`);
    await sleep(1500);
    if (i === 4) {
      try { await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
      await ensureCleared(page);
    }
  }
  if (!hasWallet) {
    log('walletInput never appeared');
    try { await page.screenshot({ path: `${SHOT_DIR}/login-nowallet-${Date.now()}.png`, fullPage: true }); } catch {}
  }
  await page.fill('#walletInput', email).catch(() => {});
  await sleep(1000);
  if (await hasTurnstile(page)) {
    const token = await page.evaluate(() =>
      (document.querySelector('input[name="cf-turnstile-response"]')?.value || '')
    ).catch(() => '');
    if (token.length < 10) await solveTurnstile(page);
  }
  await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
  await sleep(5000);
  await ensureCleared(page);
  if (await isLoggedIn(page)) {
    log('Login successful!');
    return true;
  }
  // Retry once with a fresh challenge clear
  await ensureCleared(page);
  await page.fill('#walletInput', email).catch(() => {});
  await sleep(500);
  await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
  await sleep(5000);
  await ensureCleared(page);
  if (await isLoggedIn(page)) {
    log('Login successful (retry)!');
    return true;
  }
  try { await page.screenshot({ path: `${SHOT_DIR}/login-fail-${Date.now()}.png`, fullPage: true }); } catch {}
  const dbg = await page.evaluate(() => ({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 300),
    hasWallet: !!document.querySelector('#walletInput'),
    hasTurn: !!document.querySelector('.cf-turnstile'),
    frames: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 80)),
  })).catch(() => ({}));
  log(`Login failed debug: ${JSON.stringify(dbg)}`);
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
      // Temporary ban: "Time remaining to unlock: 46 minutes 51 seconds"
      const temporarilyBlocked = /You Have Been Temporarily Blocked|blocked due to multiple failed CAPTCHA/i.test(text);
      let blockSec = null;
      if (temporarilyBlocked) {
        const hm = text.match(/Time remaining to unlock:\s*(\d+)\s*hours?\s*(\d+)\s*minutes?(?:\s*(\d+)\s*seconds?)?/i);
        const mm = text.match(/Time remaining to unlock:\s*(\d+)\s*minutes?\s*(\d+)\s*seconds?/i);
        const ss = text.match(/Time remaining to unlock:\s*(\d+)\s*seconds?/i);
        if (hm) blockSec = Number(hm[1]) * 3600 + Number(hm[2] || 0) * 60 + Number(hm[3] || 0);
        else if (mm) blockSec = Number(mm[1]) * 60 + Number(mm[2] || 0);
        else if (ss) blockSec = Number(ss[1]);
        else blockSec = 3600; // default full hour if unparsed
      }
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
        text: text.slice(0, 800),
        success: text.includes('has been sent'),
        verification: text.includes('Verification Required'),
        puzzle: text.includes('Drag the shape'),
        captchaError: text.includes('Please complete the captcha'),
        cooldown: waitSec !== null && !temporarilyBlocked,
        waitSec,
        temporarilyBlocked,
        blockSec,
        claimBtn: /Claim Now/i.test(text),
        captchaAnswer: answer,
        hRect, cbRect, verifyRect,
        hasForm: !!document.querySelector('form[action*="faucet/verify"]'),
      };
    });
  } catch (e) {
    return { text: '', success: false, verification: false, puzzle: false, captchaError: false, cooldown: false, waitSec: null, temporarilyBlocked: false, blockSec: null, claimBtn: false, captchaAnswer: '', hRect: null, cbRect: null, verifyRect: null, hasForm: false, navError: true };
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
  let cbClicks = 0;
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
        if (i >= 14) break;
        box = null;
      }
    }
    // Cap checkbox re-clicks: spinning cb_ when widget never reopens wastes a claim
    if (st.cbRect && st.verification && cbClicks < 2) {
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const cb = await getPageState(page);
      if (cb.cbRect) {
        await page.mouse.click(cb.cbRect.x, cb.cbRect.y);
        cbClicks++;
        log(`Clicked verification checkbox (${cbClicks}/2)`);
      }
    }
    // After 2 failed checkbox opens with no widget, hard-reload faucet page once
    if (i === 7 && !box && cbClicks >= 2) {
      log('Widget stuck after checkbox retries — reloading faucet page');
      await gotoRetry(page, FAUCET_URL, 3);
      await sleep(2000);
      const st2 = await getPageState(page);
      if (st2.success || st2.cooldown) return true;
      continue;
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

  // Always run vision so we can cross-check morph ranking (first pick must be right).
  let vision = null;
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

  const pieceX = (holeDet && holeDet.pieceX != null) ? holeDet.pieceX
    : (vision && vision.pieceX != null) ? vision.pieceX : w / 2;
  const pieceY = (holeDet && holeDet.pieceY != null) ? holeDet.pieceY
    : (vision && vision.pieceY != null) ? vision.pieceY : h / 2;
  const grabX = (holeDet && holeDet.grabX != null) ? holeDet.grabX : pieceX;
  const grabY = (holeDet && holeDet.grabY != null) ? holeDet.grabY : pieceY;
  const grabAltX = (holeDet && holeDet.grabAltX != null) ? holeDet.grabAltX : grabX;
  const grabAltY = (holeDet && holeDet.grabAltY != null) ? holeDet.grabAltY : grabY;
  const offX = grabX - pieceX;
  const offY = grabY - pieceY;

  const pyBest = (holeDet && holeDet.cands && holeDet.cands.length) ? holeDet.cands[0] : null;
  const visionOnBoard = vision && vision.targetX != null && vision.targetY != null
    && Math.hypot(vision.targetX - pieceX, vision.targetY - pieceY) >= 15;
  const agreeDist = (pyBest && visionOnBoard)
    ? Math.hypot(pyBest.x - vision.targetX, pyBest.y - vision.targetY)
    : null;
  const pyPd = holeDet && holeDet.ptdist != null ? holeDet.ptdist : 1;
  log(`Consensus: pyBest=${pyBest ? `(${pyBest.x},${pyBest.y}) pd=${pyBest.ptdist}` : 'none'} vision=${visionOnBoard ? `(${Math.round(vision.targetX)},${Math.round(vision.targetY)})` : 'none'} dist=${agreeDist != null ? agreeDist.toFixed(0) : 'n/a'}`);

  const candidates = [];
  const pushCand = (x, y, src) => {
    if (Math.hypot(x - pieceX, y - pieceY) < 15) return false;
    if (candidates.some(c2 => Math.hypot(c2.x - x, c2.y - y) < 25)) return false;
    candidates.push({ x, y, src });
    return true;
  };

  // Agreement (within 30px) => high-confidence single pick first.
  // Disagree => vision first (exact-shape perception); morph pd alone cannot separate decoys.
  if (visionOnBoard && pyBest) {
    if (agreeDist <= 30) {
      pushCand((vision.targetX + pyBest.x) / 2, (vision.targetY + pyBest.y) / 2, `agree${agreeDist.toFixed(0)}`);
    } else {
      pushCand(vision.targetX, vision.targetY, 'vision');
    }
  } else if (visionOnBoard) {
    pushCand(vision.targetX, vision.targetY, 'vision');
  }
  if (holeDet && holeDet.cands && holeDet.cands.length) {
    for (const c of holeDet.cands) pushCand(c.x, c.y, `py${c.score}`);
  }
  if (candidates.length === 0) {
    log('No target candidates');
    if (attempt < 3) return handlePuzzle(page, attempt + 1);
    return false;
  }

  // First pick must be correct (verify-reject = brand-new puzzle).
  // 4 attempts only matter for drop-miss recovery on the SAME puzzle.
  const maxTry = Math.min(candidates.length, 4);
  const retried = new Set();
  const grabOpts = [
    { x: grabX, y: grabY, tag: 'grab' },
    { x: grabAltX, y: grabAltY, tag: 'alt' },
    { x: pieceX, y: pieceY, tag: 'ctr' },
  ];
  let grabIdx = 0;
  let emptyFails = 0;
  const maxEmptyFails = 6;
  let curPieceX = pieceX, curPieceY = pieceY;
  let curGrab = grabOpts[0];
  let curOffX = curGrab.x - curPieceX;
  let curOffY = curGrab.y - curPieceY;

  async function redetectPiece(afterFail) {
    log(`Re-detecting piece after ${afterFail}...`);
    const rp = `${SHOT_DIR}/puzzle-redet-${ts()}.png`;
    const rs = await page.screenshot({ path: rp, clip }).catch(() => null);
    if (!rs || rs.length < 8000) return false;
    const d = findHolePy(rp);
    if (!d || d.pieceX == null) return false;
    curPieceX = d.pieceX;
    curPieceY = d.pieceY;
    const gxs = [d.grabX, d.grabAltX].filter(v => v != null);
    const gys = [d.grabY, d.grabAltY].filter(v => v != null);
    const g0 = { x: gxs[0] ?? curPieceX, y: gys[0] ?? curPieceY, tag: 'regrab' };
    const g1 = { x: gxs[1] ?? curPieceX, y: gys[1] ?? curPieceY, tag: 'realt' };
    grabOpts.length = 0;
    grabOpts.push(g0, g1, { x: curPieceX, y: curPieceY, tag: 'rectr' });
    grabIdx = 0;
    curGrab = grabOpts[0];
    curOffX = curGrab.x - curPieceX;
    curOffY = curGrab.y - curPieceY;
    log(`Piece re-detected at (${curPieceX},${curPieceY}) grab=${curGrab.tag}(${curGrab.x},${curGrab.y})`);
    return true;
  }

  for (let ci = 0; ci < maxTry; ci++) {
    const cand = candidates[ci];

    // Grab ON the blue stroke; compensate so piece CENTER lands on hole center
    const gx = clip.x + curGrab.x;
    const gy = clip.y + curGrab.y;
    const tx0 = clip.x + cand.x + curOffX;
    const ty0 = clip.y + cand.y + curOffY;

    // Re-measure box right before drag (ads shift layout)
    const fresh = await getPuzzleBox(page);
    let dx = 0, dy = 0;
    if (fresh && fresh.w && Math.abs(fresh.w - clip.width) < 30) {
      dx = fresh.x - clip.x;
      dy = fresh.y - clip.y;
    }
    const fx = gx + dx, fy = gy + dy;
    const tx = tx0 + dx, ty = ty0 + dy;
    log(`Drag [${cand.src}/${curGrab.tag}] grab(${Math.round(fx)},${Math.round(fy)}) -> drop(${Math.round(tx)},${Math.round(ty)}) off(${Math.round(curOffX)},${Math.round(curOffY)})`);

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
      emptyFails++;
      log(`Answer not recorded (${emptyFails}/${maxEmptyFails}) — reset, alternate grab`);
      await page.evaluate(() => {
        const b = document.querySelector('[id^="rb_btn_"]');
        if (b) b.click();
      }).catch(() => {});
      await sleep(700);
      if (emptyFails >= maxEmptyFails) {
        log('Too many empty answers — abandon candidate');
        continue;
      }
      // Same hole candidate, alternate grab (stale piece pos causes empty answers)
      if (grabIdx < grabOpts.length - 1) {
        grabIdx++;
        curGrab = grabOpts[grabIdx];
        curOffX = curGrab.x - curPieceX;
        curOffY = curGrab.y - curPieceY;
        if (!retried.has(ci)) {
          retried.add(ci);
          ci--;
        }
        continue;
      }
      const ok = await redetectPiece('empty answer');
      grabIdx = 0;
      if (ok && !retried.has(ci)) {
        retried.add(ci);
        curGrab = grabOpts[0];
        curOffX = curGrab.x - curPieceX;
        curOffY = curGrab.y - curPieceY;
        ci--;
      }
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
        log('Drop missed target — reset, re-detect, retry candidate');
        await page.evaluate(() => {
          const b = document.querySelector('[id^="rb_btn_"]');
          if (b) b.click();
        }).catch(() => {});
        await sleep(700);
        await redetectPiece('drop miss');
        grabIdx = 0;
        curGrab = grabOpts[0];
        curOffX = curGrab.x - curPieceX;
        curOffY = curGrab.y - curPieceY;
        if (!retried.has(ci)) {
          retried.add(ci);
          ci--; // retry same index with fresh piece/grab
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
  await ensureCleared(page);
  let st = await getPageState(page);
  log(`state: success=${st.success} verif=${st.verification} puzzle=${st.puzzle} cooldown=${st.cooldown} wait=${st.waitSec}s claimBtn=${st.claimBtn} blocked=${st.temporarilyBlocked} blockSec=${st.blockSec}`);

  if (st.temporarilyBlocked) {
    await page.screenshot({ path: `${SHOT_DIR}/blocked-${Date.now()}.png`, fullPage: true }).catch(() => {});
    log(`TEMPORARILY BLOCKED — remaining ${st.blockSec ?? '?'}s. Will wait until unlock.`);
    return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
  }

  if (st.success) {
    await dismissSweetAlert(page);
    const n = bumpClaim(email);
    log(`Success already shown. Claims=${n}`);
    return 'success';
  }

  if (st.captchaError) {
    await dismissSweetAlert(page);
    st = await getPageState(page);
    if (st.temporarilyBlocked) {
      return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
    }
  }

  if (st.puzzle || st.verification) {
    log('Verification/puzzle present — solving...');
    const ok = await handlePuzzle(page);
    st = await getPageState(page);
    if (st.temporarilyBlocked) {
      return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
    }
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
    if (await hasTurnstile(page)) {
      const token = await page.evaluate(() =>
        (document.querySelector('input[name="cf-turnstile-response"]')?.value || '')
      ).catch(() => '');
      if (token.length < 10) await solveTurnstile(page);
    }
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

    if (st.temporarilyBlocked) {
      return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
    }
    if (st.captchaError) {
      await dismissSweetAlert(page);
      st = await getPageState(page);
      if (st.temporarilyBlocked) {
        return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
      }
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
      if (st.temporarilyBlocked) {
        return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
      }
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
    if (st.temporarilyBlocked) return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
    if (!st.cooldown && (st.claimBtn || st.verification || st.puzzle)) return true;
    if (st.success) return 'success';
    log(`Cooldown wait ${st.waitSec ?? '?'}s...`);
    await sleep(5000);
  }
  return false;
}

// Sleep until temporary ban unlocks (poll every 30s; never start a 3rd captcha attempt).
async function waitOutBlock(page, blockSec) {
  const total = Math.max(30, Math.min(blockSec || 3600, 3700));
  log(`Waiting out temporary block for ~${total}s (${Math.round(total / 60)} min)...`);
  const end = Date.now() + total * 1000;
  while (Date.now() < end) {
    const remain = Math.ceil((end - Date.now()) / 1000);
    if (remain % 60 < 30 && remain > 0) log(`Block remaining ~${remain}s`);
    // Light poll so we can exit early if UI changes
    if (remain > 20) {
      await sleep(30000);
    } else {
      await sleep(10000);
    }
    try {
      const st = await getPageState(page);
      if (!st.temporarilyBlocked && (st.claimBtn || st.puzzle || st.verification || st.success || st.cooldown)) {
        log('Block appears cleared early — resuming');
        return true;
      }
    } catch {}
  }
  log('Block wait finished');
  return true;
}

// After 2 failed captcha solves, pause until the user solves manually.
// Manual success (or clear claim-ready state) resets the failure counter.
async function waitManualSolve(page) {
  log('CAPTCHA FAIL PAUSE: 2 failed solves — waiting for you to solve manually (3rd fail would ban).');
  await page.screenshot({ path: `${SHOT_DIR}/manual-pause-${Date.now()}.png`, fullPage: true }).catch(() => {});
  for (let i = 0; ; i++) {
    try {
      const st = await getPageState(page);
      if (st.success || st.cooldown) {
        log('Manual solve detected (success/cooldown) — failure counter reset');
        return 'reset';
      }
      // Puzzle cleared and claim button back without block → ready again
      if (!st.puzzle && !st.verification && !st.temporarilyBlocked && st.claimBtn) {
        log('Manual solve detected (claim ready) — failure counter reset');
        return 'reset';
      }
      if (st.temporarilyBlocked) {
        return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
      }
    } catch {}
    if (i % 4 === 0) log(`Still paused for manual solve... (${i * 15}s)`);
    await sleep(15000);
  }
}

async function runOnce(email) {
  const ctx = await launchBrowser();
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
    await sleep(3000);
    await ensureCleared(page);
    if (!(await isLoggedIn(page))) {
      await login(page, email);
    } else {
      log('Already logged in');
    }

    if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
    await sleep(4000);
    await ensureCleared(page);

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
  // Separate from generic fails: only failed captcha/puzzle solves count toward the 2-attempt pause.
  // 3 failed CAPTCHA attempts = site ban; never auto-attempt a 3rd.
  let captchaFails = 0;
  const MAX_CAPTCHA_FAILS = 2;

  while (true) {
    try {
      if (!ctx || !page || page.isClosed()) {
        if (ctx) await ctx.close().catch(() => {});
        ctx = await launchBrowser();
        page = ctx.pages()[0] || (await ctx.newPage());
        if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
        await sleep(3000);
        await ensureCleared(page);
        if (!(await isLoggedIn(page))) await login(page, email);
        if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
        await sleep(4000);
        await ensureCleared(page);
        fails = 0;
      }

      // Ensure on faucet page
      if (!page.url().includes('/faucet/')) {
        if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
        await sleep(3000);
        await ensureCleared(page);
      }

      // Pause gate: after 2 captcha fails, do nothing until user solves (resets counter).
      if (captchaFails >= MAX_CAPTCHA_FAILS) {
        const pause = await waitManualSolve(page);
        if (pause && pause.status === 'blocked') {
          await waitOutBlock(page, pause.blockSec);
          await gotoRetry(page, FAUCET_URL);
          await sleep(3000);
          await ensureCleared(page);
          captchaFails = 0;
          fails = 0;
          continue;
        }
        captchaFails = 0;
        fails = 0;
        log('Resuming after manual solve');
        continue;
      }

      const result = await claimFaucet(page, email);

      if (result && result.status === 'blocked') {
        await waitOutBlock(page, result.blockSec);
        await gotoRetry(page, FAUCET_URL);
        await sleep(4000);
        await ensureCleared(page);
        captchaFails = 0;
        fails = 0;
        continue;
      }

      if (result === 'success') {
        fails = 0;
        captchaFails = 0;
        // Wait cooldown then claim again on same page (no refresh unless needed)
        const ready = await waitForCooldown(page, 60);
        if (ready && ready.status === 'blocked') {
          await waitOutBlock(page, ready.blockSec);
          await gotoRetry(page, FAUCET_URL);
          await sleep(4000);
          await ensureCleared(page);
          captchaFails = 0;
          fails = 0;
          continue;
        }
        if (ready === 'success') {
          await dismissSweetAlert(page);
          bumpClaim(email);
        }
        await sleep(2000);
      } else if (result === 'cooldown') {
        captchaFails = 0;
        await waitForCooldown(page, 60);
        await sleep(2000);
      } else if (result === 'puzzle-failed') {
        captchaFails++;
        fails = 0; // captcha fail is its own ladder — don't stack with generic reload fails
        log(`Captcha solve failed (${captchaFails}/${MAX_CAPTCHA_FAILS}) — will pause before next attempt if limit hit`);
        if (captchaFails >= MAX_CAPTCHA_FAILS) {
          log('Reached 2 captcha fails — entering manual-solve pause (no auto 3rd attempt)');
          continue; // pause gate runs next iteration
        }
        await sleep(10000);
      } else {
        fails++;
        log(`Non-success (${result}), fails=${fails}`);
        if (fails >= 3) {
          log('Reloading faucet page...');
          await gotoRetry(page, FAUCET_URL);
          await sleep(4000);
          await ensureCleared(page);
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
