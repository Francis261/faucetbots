import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { askVision, parseJSON } from './vision.mjs';

const BASE_URL = 'https://rosecrypto.space';
const FAUCET_URL = `${BASE_URL}/faucet`;
const PROFILE = join(process.env.HOME, '.rosecrypto-chrome-profile');
const LOCKFILE = '/tmp/rosecrypto.lock';
const ACCOUNTS_FILE = join(import.meta.dirname, 'accounts.json');

const USERNAME = 'Chidera261';
const PASSWORD = 'Frank986532';

function log(msg) { console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function acquireLock() {
  if (existsSync(LOCKFILE)) {
    const pid = readFileSync(LOCKFILE, 'utf8').trim();
    let alive = false;
    try { process.kill(Number(pid), 0); alive = true; } catch {}
    if (alive) { console.error(`Bot already running (PID ${pid}).`); process.exit(1); }
    // Dead PID — remove stale lock
    try { unlinkSync(LOCKFILE); } catch {}
  }
  writeFileSync(LOCKFILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCKFILE); } catch {} });
}

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  try {
    const arr = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    // Prefer the account selected when dispatching the bot (workflow / env)
    const preferred = process.env.LOGIN_USERNAME || process.env.LOGIN_EMAIL || process.env.EMAIL;
    if (preferred) {
      const hit = arr.filter(a => a.username === preferred);
      const rest = arr.filter(a => a.username !== preferred);
      return hit.length ? [...hit, ...rest] : arr;
    }
    return arr;
  } catch { return []; }
}

function saveAccounts(accounts) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function addAccount(username, password) {
  const accounts = loadAccounts();
  if (accounts.find(a => a.username === username)) {
    log('Account already exists.');
    return false;
  }
  accounts.push({ username, password, claims: 0, lastClaim: null });
  saveAccounts(accounts);
  log(`Account added: ${username}`);
  return true;
}

function updateAccount(username, data) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.username === username);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...data };
    saveAccounts(accounts);
  }
}

async function launchBrowser() {
  mkdirSync(PROFILE, { recursive: true });
  const opts = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  if (process.env.CHROME_PATH) {
    opts.executablePath = process.env.CHROME_PATH;
  } else {
    opts.channel = process.env.CHROME_CHANNEL || 'chrome';
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, opts);
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return ctx;
}

async function getChallengeState(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

  // If real faucet content is present, we're past CF
  const onFaucet =
    bodyText.includes('Click in order') ||
    bodyText.includes('AntiBot') ||
    bodyText.includes('Claim 5 Coins') ||
    bodyText.includes('REWARD') ||
    bodyText.includes('Select the LEAST common') ||
    bodyText.includes('Click the unique icon') ||
    bodyText.includes('Icon Selected') ||
    (bodyText.includes('Security Verification') && bodyText.includes('unique icon'));
  if (onFaucet) return { onChallenge: false, verifying: false, verifyHuman: false };

  // Strict CF challenge detection — main challenge heading only
  // Do NOT match "Security Verification" section heading on faucet page
  const onChallenge =
    bodyText.includes('Performing security verification') ||
    bodyText.includes('Just a moment...');
  if (!onChallenge) return { onChallenge: false, verifying: false, verifyHuman: false };

  // Extra guard: if faucet captcha UI is also present, treat as faucet
  if (
    bodyText.includes('Select the LEAST common') ||
    bodyText.includes('Click the unique icon') ||
    bodyText.includes('Click in order') ||
    bodyText.includes('Claim 5 Coins')
  ) {
    return { onChallenge: false, verifying: false, verifyHuman: false };
  }

  // Check all frames — CF challenge iframe may be cross-origin (evaluate may fail silently)
  let verifying = false;
  let verifyHuman = false;
  let hasChallengeFrame = false;
  for (const frame of page.frames()) {
    try {
      const url = frame.url() || '';
      if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
        hasChallengeFrame = true;
        const t = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (t.includes('Verifying') || t.includes('verifying')) verifying = true;
        if (t.includes('Verify you are human') || t.includes('verify you are human')) verifyHuman = true;
      }
    } catch {}
  }

  // Cross-origin iframe unreadable — if challenge frame exists and we're not seeing verifying,
  // assume checkbox ("Verify you are human") is shown (matches screenshots)
  if (hasChallengeFrame && !verifying && !verifyHuman) {
    verifyHuman = true;
  }

  return { onChallenge: true, verifying, verifyHuman, hasChallengeFrame };
}

async function waitForCloudflare(page, maxSec = 60) {
  let verifyingSince = 0;
  let lastClickAt = 0;
  let lastLog = 0;
  let reloadCount = 0;

  for (let i = 0; i < maxSec; i++) {
    const state = await getChallengeState(page).catch(() => ({ onChallenge: false, verifying: false, verifyHuman: false }));
    if (!state.onChallenge) {
      if (i > 0) log('CF cleared');
      return true;
    }

    // Debug every 10s
    if (Date.now() - lastLog > 10000) {
      log(`CF state: verifying=${state.verifying} verifyHuman=${state.verifyHuman} frame=${state.hasChallengeFrame} i=${i}`);
      lastLog = Date.now();
      try { await page.screenshot({ path: '/tmp/rosecrypto_cf_debug.png' }); } catch {}
    }

    if (state.verifying) {
      if (!verifyingSince) verifyingSince = Date.now();

      // Stuck verifying > 20s — reload for a fresh challenge
      if (Date.now() - verifyingSince > 20000 && reloadCount < 3) {
        log('CF verifying stuck, reloading page...');
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
        await sleep(5000);
        verifyingSince = 0;
        lastClickAt = 0;
        reloadCount++;
        continue;
      }

      // Wait while verifying — do not click (user instruction)
      await sleep(2000);
      continue;
    }

    // Verifying gone or checkbox shown → click the "Verify you are human" frame body
    // Allow periodic retries — first click may fire before iframe fully loads
    if (state.verifyHuman || verifyingSince) {
      const now = Date.now();
      if (!lastClickAt || now - lastClickAt > 6000) {
        log('Clicking Verify you are human body...');
        await clickChallengeBody(page);
        lastClickAt = now;
        verifyingSince = 0;
        await sleep(6000);

        const still = await getChallengeState(page).catch(() => ({ onChallenge: false }));
        if (!still.onChallenge) return true;
        // Still on challenge — loop will retry after cooldown
      } else {
        await sleep(2000);
      }
      continue;
    }

    // On challenge but no state info — click widget coords as fallback
    // Cap fallback clicks; reload if widget never loads or stuck too long
    if (i > 3) {
      const now = Date.now();
      if (!lastClickAt || now - lastClickAt > 6000) {
        // No CF frame at all after a few seconds — widget failed to load, reload
        if (!state.hasChallengeFrame && i > 8 && reloadCount < 3) {
          log('CF widget not loaded, reloading page...');
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
          await sleep(6000);
          reloadCount++;
          lastClickAt = 0;
          continue;
        }
        if (i > 30 && reloadCount < 3) {
          log('CF stuck too long, reloading page...');
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
          await sleep(5000);
          reloadCount++;
          lastClickAt = 0;
          continue;
        }
        if (i > 55 || reloadCount >= 3) {
          log('CF giving up after many attempts');
          return false;
        }
        log('On challenge, clicking widget fallback...');
        await page.mouse.click(215, 336);
        lastClickAt = now;
        await sleep(6000);
      } else {
        await sleep(2000);
      }
      continue;
    }

    await sleep(2000);
  }
  log('waitForCloudflare timed out');
  try { await page.screenshot({ path: '/tmp/rosecrypto_cf_timeout.png' }); } catch {}
  return false;
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
      log(`Clicking CF via frameElement at (${Math.round(pageX)}, ${Math.round(pageY)}) box=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`);
      await page.mouse.move(pageX, pageY, { steps: 8 });
      await sleep(300);
      await page.mouse.click(pageX, pageY);
      return true;
    } catch {}
  }

  // Log all iframes and frames for debugging
  const allIframes = await page.evaluate(() => {
    return [...document.querySelectorAll('iframe')].map(f => {
      const r = f.getBoundingClientRect();
      return { src: (f.src || '').slice(0, 120), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
  }).catch(() => []);
  log(`DOM iframes (${allIframes.length}): ${JSON.stringify(allIframes.slice(0, 5))}`);

  const frameUrls = page.frames().map(f => {
    try { return (f.url() || '').slice(0, 100); } catch { return 'err'; }
  });
  log(`Frames: ${JSON.stringify(frameUrls)}`);

  // Get challenge iframe page-position — match any CF frame URL pattern
  const iframePos = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')];
    // Prefer known CF patterns
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
    log(`Clicking iframe checkbox area at (${Math.round(pageX)}, ${Math.round(pageY)})`);
    await page.mouse.move(pageX, pageY, { steps: 5 });
    await sleep(200);
    await page.mouse.click(pageX, pageY);
    return true;
  }

  // Fallback: hardcoded widget checkbox position from screenshots
  log('Clicking checkbox fallback at (215, 336)');
  await page.mouse.move(215, 336, { steps: 5 });
  await sleep(200);
  await page.mouse.click(215, 336);
  return false;
}

async function solveTurnstile(page) {
  log('Solving Turnstile...');

  // Click the turnstile container area multiple times to trigger token generation
  const tb = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (!tb) {
    log('No turnstile found');
    return false;
  }

  for (let i = 0; i < 10; i++) {
    await page.mouse.click(tb.x, tb.y);
    await sleep(1500);

    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return input?.value || '';
    });

    if (token.length > 10) {
      log(`Turnstile solved (token: ${token.slice(0, 20)}...)`);
      return true;
    }
  }

  log('Turnstile failed');
  return false;
}

async function login(page, username, password) {
  log('Navigating to login...');

  for (let i = 0; i < 5; i++) {
    try {
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      break;
    } catch { await sleep(5000); }
  }

  // Session may already be logged in
  if (page.url().includes('dashboard')) {
    log('Already logged in (session), going to faucet...');
    return await goFaucetAfterLogin(page);
  }

  // Wait for CF challenge to resolve
  const cfOk = await waitForCloudflare(page, 60);
  if (!cfOk) {
    log('CF challenge stuck');
    try { await page.screenshot({ path: '/tmp/rosecrypto_cf_login.png' }); } catch {}
    return false;
  }

  // Ensure we're on login form
  const readyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (!readyText.includes('Username') && !readyText.includes('Login')) {
    log('Not on login form after CF');
    return false;
  }

  await sleep(2000);

  // Fill form
  await page.fill('input[name="username"]', username);
  await sleep(200);
  await page.fill('input[name="password"]', password);
  await sleep(200);

  // Solve turnstile
  await solveTurnstile(page);

  // Submit
  await page.click('button[type="submit"]');
  await sleep(12000);

  const url = page.url();
  if (url.includes('dashboard')) {
    log('Login successful! Going to faucet...');
    return await goFaucetAfterLogin(page);
  }

  log(`Login failed (URL: ${url})`);
  return false;
}

async function goFaucetAfterLogin(page) {
    // Navigate directly to faucet
    for (let i = 0; i < 3; i++) {
      try {
        await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        break;
      } catch { await sleep(5000); }
    }
    await sleep(5000);

    // Handle CF challenge on faucet — loop until real faucet content appears
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const onCF =
          (text.includes('Performing security verification') || text.includes('Just a moment') || text.includes('Verify you are human')) &&
          !text.includes('Select the LEAST common') &&
          !text.includes('Click the unique icon') &&
          !text.includes('Click in order') &&
          !text.includes('Claim 5 Coins');
        const onFaucet =
          text.includes('Click in order') ||
          text.includes('Claim') ||
          text.includes('AntiBot') ||
          text.includes('REWARD') ||
          text.includes('Select the LEAST common') ||
          text.includes('Click the unique icon');

        if (onFaucet && !onCF) {
          log('Faucet page loaded');
          break;
        }

        if (onCF) {
          log(`CF challenge on faucet (attempt ${attempt + 1}), solving...`);
          await waitForCloudflare(page, 60);
          await sleep(3000);
        } else {
          // Not CF, not faucet yet — wait for render
          await sleep(5000);
        }
      } catch { await sleep(3000); }

      if (attempt === 4) {
        log('Faucet page did not load cleanly');
        return false;
      }
    }

    // Check for turnstile on faucet page
    try {
      const hasTurnstile = await page.evaluate(() => !!document.querySelector('.cf-turnstile'));
      if (hasTurnstile) {
        await solveTurnstile(page);
        await sleep(3000);
      }
    } catch {}

    try {
      const faucetText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');
      log('Faucet: ' + faucetText.slice(0, 80).replace(/\n/g, ' '));
    } catch {}
    return true;
}

async function navigateToFaucet(page) {
  log('Navigating to faucet...');

  // Try clicking faucet link from dashboard
  const link = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/faucet"]');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (link) {
    await page.mouse.click(link.x, link.y);
    await sleep(15000);
  } else {
    for (let i = 0; i < 3; i++) {
      try {
        await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        break;
      } catch { await sleep(5000); }
    }
    await sleep(15000);
  }

  // Handle CF challenge on faucet page
  const onCF = await page.evaluate(() => document.body?.innerText?.includes('security verification'));
  if (onCF) {
    log('Cloudflare challenge on faucet, solving...');
    const solved = await waitForCloudflare(page, 90);
    if (!solved) {
      log('CF challenge not resolved');
      return false;
    }
    await sleep(5000);
  }

  // Also check for turnstile on the faucet page itself
  const hasTurnstile = await page.evaluate(() => !!document.querySelector('.cf-turnstile'));
  if (hasTurnstile) {
    log('Turnstile on faucet page, solving...');
    await solveTurnstile(page);
    await sleep(3000);
  }

  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
  log('Faucet page: ' + text.slice(0, 100));
  return !text.includes('security verification');
}

async function solveEmojiCaptcha(page, context) {
  log('Solving emoji captcha...');

  const faucetUrl = FAUCET_URL;
  const startUrl = page.url();

  // Helper: if click opened a new tab or navigated away, return to faucet without refresh
  const returnToFaucet = async () => {
    // Close any new tabs/popups, keep the original faucet tab
    if (context) {
      const pages = context.pages();
      if (pages.length > 1) {
        log(`Detected ${pages.length} tabs, closing extras...`);
        for (const p of pages) {
          if (p !== page && !p.isClosed()) {
            try { await p.close({ runBeforeUnload: false }); } catch {}
          }
        }
      }
    }
    // If same page navigated away, go back (history) — no refresh
    const cur = page.url();
    if (!cur.includes('rosecrypto.space') || !cur.includes('/faucet')) {
      log(`Navigated away to ${cur.slice(0, 80)}, going back without refresh...`);
      try {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      } catch {
        // goBack failed — soft navigate (still avoid hard reload of state if possible)
        try { await page.goto(faucetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
      }
      await sleep(3000);
    }
  };

  // Find the instruction text
  const instruction = await page.evaluate(() => {
    const els = document.querySelectorAll('*');
    for (const el of els) {
      const text = el.innerText?.trim() || '';
      if (text.includes('Click in order') && text.length < 300) {
        return text;
      }
    }
    return null;
  });

  if (!instruction) {
    log('No emoji captcha found');
    return false;
  }

  log('Instruction: ' + instruction);

  // Parse order from instruction
  const animals = [
    { emoji: '🐯', name: 'Tiger' },
    { emoji: '🐰', name: 'Rabbit' },
    { emoji: '🐻', name: 'Bear' },
    { emoji: '🐼', name: 'Panda' },
    { emoji: '🦁', name: 'Lion' },
    { emoji: '🦊', name: 'Fox' },
    { emoji: '🐺', name: 'Wolf' },
    { emoji: '🐸', name: 'Frog' },
    { emoji: '🐵', name: 'Monkey' },
    { emoji: '🐶', name: 'Dog' },
    { emoji: '🐱', name: 'Cat' },
  ];

  const emojiOrder = [];
  for (const a of animals) {
    const emojiIdx = instruction.indexOf(a.emoji);
    const nameIdx = instruction.indexOf(a.name);
    if (emojiIdx === -1 && nameIdx === -1) continue;
    const earliest = Math.min(...[emojiIdx, nameIdx].filter(x => x !== -1));
    emojiOrder.push({ ...a, idx: earliest });
  }
  emojiOrder.sort((a, b) => a.idx - b.idx);

  log('Click order: ' + emojiOrder.map(e => e.name).join(' → '));

  // Find and click each animal button
  let allFound = true;
  for (const { emoji, name } of emojiOrder) {
    // Ensure we're still on faucet before each click
    await returnToFaucet();

    // Strict match: button-like element with emoji+name, short text, not instruction/ad
    const pos = await page.evaluate(({ em, nm }) => {
      const els = document.querySelectorAll('button, a, [role="button"], input[type="button"], span, div');
      let best = null;
      for (const el of els) {
        const t = (el.innerText || el.value || '').trim();
        if (!t || t.length > 30) continue;
        if (t.includes('Click in order')) continue;
        if (t.includes('Claim') || t.includes('Security') || t.includes('Auto earn')) continue;
        // Must contain both emoji and name, or exact-ish match
        const hasEm = t.includes(em);
        const hasNm = t.includes(nm);
        if (!(hasEm && hasNm) && !(hasNm && t.length < 20)) continue;
        if (!hasEm && !hasNm) continue;

        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 15) continue;
        // Skip if overlapping obvious ad containers
        if (r.width > 400 && r.height > 100) continue;

        // Prefer real buttons
        const tag = el.tagName?.toLowerCase() || '';
        const isBtn = tag === 'button' || el.getAttribute('role') === 'button' || tag === 'a';
        if (isBtn && !best) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r2 = el.getBoundingClientRect();
          best = { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2, score: 2 };
        } else if (!best) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r2 = el.getBoundingClientRect();
          best = { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2, score: 1 };
        }
      }
      return best;
    }, { em: emoji, nm: name });

    if (pos) {
      log(`Clicking ${name} at (${Math.round(pos.x)}, ${Math.round(pos.y)})`);
      await page.mouse.move(pos.x, pos.y, { steps: 3 });
      await sleep(150);
      await page.mouse.click(pos.x, pos.y);
      await sleep(1500);

      // After click: detect redirect/new tab and return without refresh
      await returnToFaucet();

      // Wait for this button to disappear
      for (let w = 0; w < 8; w++) {
        await sleep(800);
        const gone = await page.evaluate(({ em, nm }) => {
          const els = document.querySelectorAll('button, a, [role="button"], span, div');
          for (const el of els) {
            const t = (el.innerText || '').trim();
            if (!t || t.length > 30) continue;
            if (t.includes('Click in order') || t.includes('Claim') || t.includes('Security')) continue;
            if ((t.includes(em) && t.includes(nm)) || (t.includes(nm) && t.length < 20)) {
              const r = el.getBoundingClientRect();
              if (r.width >= 30 && r.height >= 15 && r.width < 400) return false;
            }
          }
          return true;
        }, { em: emoji, nm: name });
        if (gone) break;
        // Also re-check we didn't drift away while waiting
        if (w === 3) await returnToFaucet();
      }
    } else {
      log(`${name} not found`);
      allFound = false;
    }
  }

  await returnToFaucet();
  await sleep(2000);

  // Verify emoji instruction is gone (solved) or at least all buttons were found
  const after = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (after.includes('Click in order') && !allFound) {
    log('Emoji captcha still present after clicks');
    return false;
  }
  return true;
}

async function solveSecurityVerification(page) {
  log('Solving Security Verification (least common icon)...');

  // Already solved?
  {
    const early = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (early.includes('Icon Selected')) {
      log('Security verification already selected');
      return true;
    }
  }

  // Wait for instruction to load
  let instructionReady = false;
  for (let w = 0; w < 12; w++) {
    const t = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (t.includes('Select the LEAST common') || t.includes('Click the unique icon') || t.includes('Icon Selected')) {
      instructionReady = true;
      break;
    }
    if (w === 0) log('Waiting for Security Verification instruction...');
    await sleep(1000);
  }
  if (!instructionReady) {
    log('Security Verification instruction never appeared');
    return false;
  }
  await sleep(500);

  if ((await page.evaluate(() => document.body?.innerText || '').catch(() => '')).includes('Icon Selected')) {
    log('Security verification already selected');
    return true;
  }

  // Hide ads/overlays
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el => {
      const t = (el.innerText || '').trim();
      if (t.includes('Surfe.be') || t.includes('Advertising platform') || t.includes('Attract affiliates')) {
        if (t.length < 500) el.style.visibility = 'hidden';
      }
      const s = getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'sticky') && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
        const r = el.getBoundingClientRect();
        if (r.height > 50 && r.width > 200) el.style.visibility = 'hidden';
      }
    });
  });
  await sleep(400);

  // Find icon row container and each icon's DOM position
  const iconData = await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')];
    let instr = null;
    for (const el of els) {
      const t = (el.innerText || '').trim();
      if (t.includes('Select the LEAST common') || t.includes('Click the unique icon')) {
        if (!instr || t.length < (instr.innerText || '').length) instr = el;
      }
    }
    if (!instr) return null;

    // Scroll instruction into center
    instr.scrollIntoView({ block: 'center', behavior: 'instant' });

    // Find parent containing multiple button/icon children
    let row = null;
    let p = instr;
    for (let i = 0; i < 8 && p; i++) {
      const candidates = [...p.querySelectorAll('button, [role="button"], [class*="icon"], [class*="option"], [class*="choice"]')];
      // Also consider clickable imgs/canvas/svg inside buttons
      if (candidates.length >= 3) {
        row = p;
        break;
      }
      p = p.parentElement;
    }
    if (!row) return null;

    // Collect icon positions — unique by center coords
    const seen = new Set();
    const icons = [];
    const interactives = [...row.querySelectorAll('button, [role="button"], [class*="icon"], [class*="option"], [class*="choice"], img, canvas, svg')];
    for (const el of interactives) {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20 || r.width > 200 || r.height > 200) continue;
      if (r.top < 0 || r.bottom > window.innerHeight) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const key = `${Math.round(cx / 10)}_${Math.round(cy / 10)}`;
      if (seen.has(key)) continue;
      // Skip elements that are ancestors of other candidates (prefer leaf icons)
      const isContainer = interactives.some(o => o !== el && el.contains(o) &&
        o.getBoundingClientRect().width >= 20 && o.getBoundingClientRect().height >= 20);
      if (isContainer) continue;
      seen.add(key);
      icons.push({ x: cx, y: cy, w: r.width, h: r.height });
    }

    // Fallback: look for buttons only
    if (icons.length < 3) {
      const btns = [...row.querySelectorAll('button, [role="button"]')];
      const seen2 = new Set();
      icons.length = 0;
      for (const el of btns) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const key = `${Math.round(cx / 10)}_${Math.round(cy / 10)}`;
        if (seen2.has(key)) continue;
        seen2.add(key);
        icons.push({ x: cx, y: cy, w: r.width, h: r.height });
      }
    }

    // Sort left to right
    icons.sort((a, b) => a.x - b.x);

    // Row bounding box for screenshot
    const rr = row.getBoundingClientRect();
    const ir = instr.getBoundingClientRect();
    const box = {
      x: Math.max(0, Math.min(rr.x, ir.x) - 15),
      y: Math.max(0, Math.min(rr.y, ir.y) - 15),
      width: Math.min(Math.max(rr.width, ir.width) + 30, window.innerWidth),
      height: Math.min(Math.max(rr.bottom, ir.bottom) - Math.min(rr.y, ir.y) + 30, window.innerHeight)
    };

    return { icons, box };
  });

  if (!iconData || !iconData.icons || iconData.icons.length < 3) {
    log(`Icon row not found (icons: ${iconData?.icons?.length ?? 0})`);
    return false;
  }

  log(`Found ${iconData.icons.length} icons: ${iconData.icons.map((i, n) => `${n + 1}@(${Math.round(i.x)},${Math.round(i.y)})`).join(' ')}`);

  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const clip = {
    x: Math.max(0, Math.min(iconData.box.x, vp.width - 10)),
    y: Math.max(0, Math.min(iconData.box.y, vp.height - 10)),
    width: 0,
    height: 0
  };
  clip.width = Math.min(iconData.box.width, vp.width - clip.x);
  clip.height = Math.min(iconData.box.height, vp.height - clip.y);
  if (clip.width < 50 || clip.height < 50) {
    log(`Invalid clip ${clip.width}x${clip.height}`);
    return false;
  }

  // Timestamped screenshots for debugging
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const shotPath = `/tmp/rosecrypto_secver_${ts}.png`;
  const latestPath = '/tmp/rosecrypto_secver.png';
  await page.screenshot({ path: shotPath, clip });
  await page.screenshot({ path: latestPath, clip });
  // Also full viewport for reference
  await page.screenshot({ path: `/tmp/rosecrypto_secver_full_${ts}.png` });
  log(`SecVer screenshot saved: ${shotPath} (${clip.width}x${clip.height})`);

  const n = iconData.icons.length;
  const centersX = iconData.icons.map(i => Math.round(i.x)).join(',');
  const centersY = iconData.icons.map(i => Math.round(i.y)).join(',');

  const solveOnce = async (imgPath, imgW, imgH) => {
    const answer = await askVision(
      `Image shows a row of ${n} icons (positions 1 to ${n}, left to right). ` +
      `Exactly ONE icon is the LEAST COMMON / different from the others — different shape, e.g. ` +
      `if you see [fire, lightning, fire, fire, fire] the lightning (position 2) is least common. ` +
      `Like finding G in AGAAA. Icons may be different shapes each round (fire, diamond, heart, etc). ` +
      `Image size: ${imgW}x${imgH} pixels. ` +
      `Identify which position number (1-${n}) is the unique/least common icon. ` +
      `Return ONLY JSON: {"unique":"description","position":NUMBER}` +
      ` where position is an integer from 1 to ${n}.`,
      [imgPath]
    );
    log('Vision: ' + answer.slice(0, 300));
    const parsed = parseJSON(answer);
    if (!parsed) {
      log('Vision: no JSON');
      return false;
    }
    let pos = parsed.position ?? parsed.pos ?? parsed.x;
    // If model returned x as pixel coord within image, map to nearest icon
    if (typeof pos === 'number' && (pos > n || pos < 1 || !Number.isInteger(pos))) {
      // Maybe pixel x — map to nearest icon by image-relative position
      if (typeof parsed.x === 'number' && parsed.x > n) {
        const frac = parsed.x / imgW;
        pos = Math.max(1, Math.min(n, Math.round(frac * n)));
        log(`Mapped pixel x=${parsed.x} → position ${pos}`);
      } else if (Number.isInteger(pos) && pos >= 1 && pos <= n) {
        // ok
      } else {
        log(`Invalid position: ${JSON.stringify(parsed)}`);
        return false;
      }
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > n) {
      log(`Position out of range 1-${n}: ${pos}`);
      return false;
    }

    const target = iconData.icons[pos - 1];
    log(`Clicking position ${pos} "${parsed.unique || '?'}" at (${Math.round(target.x)}, ${Math.round(target.y)})`);
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await sleep(200);
    await page.mouse.click(target.x, target.y);
    await sleep(3000);

    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (
      text.includes('Icon Selected') ||
      text.includes('correct') ||
      text.includes('passed') ||
      (!text.includes('LEAST common') && !text.includes('Click the unique') && !text.includes('Select the LEAST'))
    ) {
      log('Security verification passed');
      return true;
    }
    log('Still present after click');
    return false;
  };

  try {
    let ok = await solveOnce(shotPath, clip.width, clip.height);
    if (ok) return true;

    // Attempt 2: full viewport (icon coords are page-absolute so still work)
    await page.screenshot({ path: shotPath });
    log(`Full viewport retry: ${vp.width}x${vp.height}`);
    ok = await solveOnce(shotPath, vp.width, vp.height);
    if (ok) return true;

    // Attempt 3: re-scroll and re-find icons (layout may have shifted)
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('*')];
      for (const el of els) {
        const t = (el.innerText || '').trim();
        if (t.includes('Select the LEAST common icon')) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          return;
        }
      }
    });
    await sleep(800);
    await page.screenshot({ path: shotPath, clip });
    ok = await solveOnce(shotPath, clip.width, clip.height);
    return ok;
  } catch (e) {
    log('Vision error: ' + e.message);
    return false;
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[style*="visibility: hidden"]').forEach(el => { el.style.visibility = ''; });
    }).catch(() => {});
  }
}

async function claimFaucet(page, context, attempt = 0) {
  log(`Checking faucet status... (attempt ${attempt + 1})`, context);

  if (attempt > 5) {
    log('Too many claim attempts, giving up this round');
    return false;
  }

  const pageState = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const hasClaimBtn = /Claim\s+\d+\s+Coins/.test(text);
    const needsEmoji = text.includes('Click in order');
    const needsSecurityVer =
      text.includes('LEAST common icon') ||
      text.includes('Click the unique icon') ||
      text.includes('Select the LEAST');
    const needsVerification = !needsSecurityVer && (text.includes('Verification Required') || text.includes('Performing security verification'));
    const hasSuccess =
      !hasClaimBtn &&
      !needsEmoji &&
      (text.includes('successfully') || text.includes('has been sent'));
    // Only treat as claimed if explicit messages present AND no claim button / antibot available
    const alreadyClaimed =
      (text.includes('already claimed') || text.includes('You have already') || text.includes('Come back later')) &&
      !text.includes('Click in order') &&
      !/Claim\s+\d+\s+Coins/.test(text);
    const onCooldown =
      !hasClaimBtn &&
      !needsEmoji &&
      (
        /faucet (?:ready|available) in/i.test(text) ||
        /next claim in/i.test(text) ||
        /TIMER\s*\n?\s*\d/.test(text) ||
        /TIMER\s+\d+\s*Min/i.test(text) ||
        /\bTimer\b[\s:]+\d+:\d\d/.test(text) ||
        /claim (?:available|ready) again/i.test(text) ||
        /\d+:\d\d/.test(text) && /(?:timer|wait|cooldown|ready)/i.test(text)
      );
    return { hasClaimBtn, needsEmoji, needsVerification, needsSecurityVer, hasSuccess, alreadyClaimed: alreadyClaimed || onCooldown };
  });

  log('State: ' + JSON.stringify(pageState));

  if (pageState.hasSuccess || pageState.alreadyClaimed) {
    log('Already claimed or success');
    return true;
  }

  if (pageState.needsVerification) {
    log('CF challenge detected in claimFaucet, solving...');
    const ok = await waitForCloudflare(page, 60);
    if (!ok) {
      log('CF failed — reloading to start afresh');
      await reloadFaucet(page);
      return await claimFaucet(page, context, attempt + 1);
    }
    await sleep(3000);
    return await claimFaucet(page, context, attempt + 1);
  }

  // Solve emoji captcha if needed
  if (pageState.needsEmoji) {
    const emojiOk = await solveEmojiCaptcha(page, context);
    await sleep(2000);
    if (!emojiOk) {
      log('Emoji captcha failed — reloading to start afresh');
      await reloadFaucet(page);
      return await claimFaucet(page, context, attempt + 1);
    }
  }

  // Re-check: Security Verification instruction may appear after emoji solve
  const secVerPresent = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return t.includes('LEAST common icon') || t.includes('Click the unique icon') || t.includes('Select the LEAST');
  }).catch(() => false);
  if (secVerPresent) {
    const secOk = await solveSecurityVerification(page);
    await sleep(2000);
    if (!secOk) {
      // Check if maybe it passed anyway
      const after = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (!after.includes('Icon Selected') &&
          (after.includes('LEAST common') || after.includes('Click the unique') || after.includes('Select the LEAST'))) {
        log('Security Verification failed — reloading to start afresh');
        await reloadFaucet(page);
        return await claimFaucet(page, context, attempt + 1);
      }
    }
  }

  // Solve turnstile if present
  const hasTurnstile = await page.evaluate(() => !!document.querySelector('.cf-turnstile'));
  if (hasTurnstile) {
    await solveTurnstile(page);
    await sleep(2000);
  }

  // Click claim button
  const claimBtn = await page.evaluate(() => {
    const btns = document.querySelectorAll('button, a');
    for (const btn of btns) {
      const text = btn.innerText?.trim() || '';
      if (/Claim\s+\d+\s+Coins/.test(text)) {
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = btn.getBoundingClientRect();
        if (r.width > 0) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, text };
        }
      }
    }
    return null;
  });

  if (claimBtn) {
    log(`Clicking: ${claimBtn.text}`);
    await page.mouse.click(claimBtn.x, claimBtn.y);
    await sleep(10000);

    const afterText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');

    // Connection / network error — not a successful claim
    if (
      afterText.includes("can't be reached") ||
      afterText.includes('unexpectedly closed') ||
      afterText.includes('ERR_') ||
      afterText.includes('ERR_CONNECTION') ||
      afterText.includes('This site') ||
      afterText.trim() === ''
    ) {
      log('Connection error after claim — reloading to start afresh');
      await reloadFaucet(page);
      return await claimFaucet(page, context, attempt + 1);
    }

    if (
      afterText.includes('successfully') ||
      afterText.includes('has been sent') ||
      /Coins claimed/i.test(afterText) ||
      /TIMER\s*\n?\s*\d/.test(afterText) ||
      /\d+:\d\d/.test(afterText)
    ) {
      log('Claim successful!');
      return true;
    }
    // Claim may have failed due to captcha — reload and retry
    if (afterText.includes('LEAST common') || afterText.includes('Click in order') || afterText.includes('incorrect') || afterText.includes('wrong')) {
      log('Claim rejected (captcha?) — reloading to start afresh');
      await reloadFaucet(page);
      return await claimFaucet(page, context, attempt + 1);
    }
    log('After claim: ' + afterText.slice(0, 150));

    // Check if claim button still present — means claim didn't go through
    const stillHasBtn = /Claim\s+\d+\s+Coins/.test(afterText);
    if (stillHasBtn || afterText.includes('Click in order')) {
      log('Claim did not complete — reloading to start afresh');
      await reloadFaucet(page);
      return await claimFaucet(page, context, attempt + 1);
    }

    // Claim button gone and no error — likely succeeded (timer appearing)
    return true;
  }

  log('Claim button not found — waiting for page to settle...');

  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const retry = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const hasClaimBtn = /Claim\s+\d+\s+Coins/.test(text);
      const needsEmoji = text.includes('Click in order');
      const needsSecurityVer =
        text.includes('LEAST common icon') ||
        text.includes('Click the unique icon') ||
        text.includes('Select the LEAST');
      const hasSuccess =
        !hasClaimBtn &&
        !needsEmoji &&
        (text.includes('successfully') || text.includes('has been sent'));
      const alreadyClaimed =
        (text.includes('already claimed') || text.includes('You have already') || text.includes('Come back later')) &&
        !text.includes('Click in order') &&
        !/Claim\s+\d+\s+Coins/.test(text);
      const onCooldown =
        !hasClaimBtn &&
        !needsEmoji &&
        (
          /faucet (?:ready|available) in/i.test(text) ||
          /next claim in/i.test(text) ||
          /TIMER\s*\n?\s*\d/.test(text) ||
          /TIMER\s+\d+\s*Min/i.test(text) ||
          /\bTimer\b[\s:]+\d+:\d\d/.test(text) ||
          /claim (?:available|ready) again/i.test(text)
        );
      return { hasClaimBtn, needsEmoji, needsSecurityVer, hasSuccess, alreadyClaimed: alreadyClaimed || onCooldown };
    }).catch(() => null);
    if (!retry) continue;
    log(`Retry ${i + 1}: ${JSON.stringify(retry)}`);
    if (retry.hasSuccess || retry.alreadyClaimed) {
      log('Claimed or on cooldown');
      return true;
    }
    if (retry.needsEmoji || retry.needsSecurityVer || retry.hasClaimBtn) {
      return await claimFaucet(page, context, attempt + 1);
    }
  }

  log('Claim button not found after wait — reloading to start afresh');
  await reloadFaucet(page);
  return await claimFaucet(page, context, attempt + 1);
}

async function reloadFaucet(page) {
  log('Reloading faucet page...');
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      break;
    } catch (e) {
      log(`Reload attempt ${i + 1} failed: ${e.message.slice(0, 60)}`);
      await sleep(5000);
    }
  }
  await sleep(5000);
  // Clear CF if it appeared
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (text.includes('Performing security verification') || text.includes('Just a moment')) {
    await waitForCloudflare(page, 60);
    await sleep(3000);
  }
  log('Reload complete');
}

async function waitForTimerAndClaim(page, context, account) {
  // Stay on the same page — poll until cooldown ends and claim is ready again.
  // Do NOT refresh or close the browser.
  log('Waiting for faucet timer countdown (no refresh)...');

  const maxWaitMin = 10;
  const start = Date.now();

  while (Date.now() - start < maxWaitMin * 60 * 1000) {
    await sleep(15000);

    const state = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const hasClaimBtn = /Claim\s+\d+\s+Coins/.test(text);
      const needsEmoji = text.includes('Click in order');
      const needsSecurityVer =
        text.includes('LEAST common icon') ||
        text.includes('Click the unique icon') ||
        text.includes('Select the LEAST');
      const hasSuccess = text.includes('successfully') || text.includes('has been sent');
      // Extract timer text
      const timerMatch = text.match(/(?:TIMER|Timer|timer)\s*\n?\s*([^\n]{1,30})/);
      const timerText = timerMatch ? timerMatch[1].trim() : '';
      // Cooldown patterns: "3 Min", "2:45", "0:30"
      const cooldownMatch = text.match(/\b(\d+):(\d{2})\b/) ||
                            text.match(/TIMER\s*\n?\s*(\d+)\s*Min/i) ||
                            text.match(/(\d+)\s*minutes?\s*left/i);
      const onCooldown = !hasClaimBtn && !needsEmoji && (
        cooldownMatch ||
        /faucet (?:ready|available) in/i.test(text) ||
        /next claim in/i.test(text) ||
        /come back later/i.test(text)
      );
      return { hasClaimBtn, needsEmoji, needsSecurityVer, hasSuccess, timerText, onCooldown, snippet: text.slice(0, 200) };
    }).catch(() => null);

    if (!state) continue;

    const elapsed = Math.round((Date.now() - start) / 1000);
    log(`Wait ${elapsed}s: claimBtn=${state.hasClaimBtn} emoji=${state.needsEmoji} secver=${state.needsSecurityVer} cooldown=${state.onCooldown} timer="${state.timerText}"`);

    if (state.hasClaimBtn || state.needsEmoji || state.needsSecurityVer) {
      log('Timer finished — claim ready, claiming without refresh...');
      const claimed = await claimFaucet(page, context);
      if (claimed) {
        updateAccount(account.username, { lastClaim: new Date().toISOString(), claims: (account.claims || 0) + 1 });
        account.claims = (account.claims || 0) + 1;
        log('Claim processed!');
        return true;
      }
      log('Claim after timer failed — will keep waiting');
    }

    // If page went to CF challenge while waiting, solve it without full reload if possible
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (text.includes('Performing security verification') || text.includes('Just a moment')) {
      log('CF appeared while waiting, solving...');
      await waitForCloudflare(page, 60);
    }
  }

  log('Timer wait timed out (10 min)');
  return false;
}

async function run() {
  log('=== RoseCrypto Faucet Bot Started ===');

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    log('No accounts found. Run: node bot.mjs add <username> <password>');
    process.exit(0);
  }

  let ctx = null;
  let page = null;

  const ensureBrowser = async () => {
    if (ctx && page && !page.isClosed()) {
      try {
        // Quick sanity check
        await page.evaluate(() => 1);
        return page;
      } catch {}
    }
    // Relaunch — keep profile so session persists
    try { if (ctx) await ctx.close().catch(() => {}); } catch {}
    ctx = await launchBrowser();
    page = ctx.pages()[0] || (await ctx.newPage());
    return page;
  };

  // Main loop: keep browser open forever, claim when ready
  while (true) {
    for (const account of accounts) {
      try {
        const p = await ensureBrowser();
        log(`\n--- Processing: ${account.username} ---`);

        // Login/navigate only if not already on faucet
        const curUrl = p.url();
        const onFaucetAlready = curUrl.includes('/faucet');
        let ready = false;

        if (onFaucetAlready) {
          // Already on faucet — check if claimable without navigation
          const text = await p.evaluate(() => document.body?.innerText || '').catch(() => '');
          const claimable =
            /Claim\s+\d+\s+Coins/.test(text) ||
            text.includes('Click in order') ||
            text.includes('Select the LEAST common');
          if (claimable) {
            log('Already on faucet and claimable — skipping login');
            ready = true;
          } else {
            log('On faucet but not claimable yet (cooldown?) — will wait');
            // Fall through to timer wait
            ready = 'cooldown';
          }
        }

        if (ready === true) {
          await p.screenshot({ path: '/tmp/rosecrypto_faucet.png' });
          const claimed = await claimFaucet(p, ctx);
          if (claimed) {
            updateAccount(account.username, { lastClaim: new Date().toISOString(), claims: (account.claims || 0) + 1 });
            account.claims = (account.claims || 0) + 1;
            log('Claim processed!');
          }
        } else if (ready === 'cooldown') {
          // Wait on page for timer, then claim — no refresh
          await waitForTimerAndClaim(p, ctx, account);
        } else {
          // Need login/navigation
          const loggedIn = await login(p, account.username, account.password);
          if (!loggedIn) {
            log('Login failed — reloading to start afresh...');
            await sleep(10000);
            // Force fresh navigation next time
            try { await p.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
            await sleep(5000);
            continue;
          }

          await p.screenshot({ path: '/tmp/rosecrypto_faucet.png' });
          const claimed = await claimFaucet(p, ctx);
          if (claimed) {
            updateAccount(account.username, { lastClaim: new Date().toISOString(), claims: (account.claims || 0) + 1 });
            account.claims = (account.claims || 0) + 1;
            log('Claim processed!');
          }
        }

        // After claim (success or not): wait on same page for timer, then claim again
        // Do NOT close browser, do NOT refresh
        await waitForTimerAndClaim(p, ctx, account);

      } catch (e) {
        log(`Error for ${account.username}: ${e.message.slice(0, 100)}`);
        // On error — reload page to start afresh (keep browser open)
        try {
          if (page && !page.isClosed()) {
            await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await sleep(5000);
          }
        } catch {}
        await sleep(15000);
      }
    }

    // Brief pause between account rounds — browser stays open
    log('Round complete — browser stays open, continuing...');
    await sleep(10000);
  }
}

// CLI
const args = process.argv.slice(2);
if (args[0] === 'add' && args[1] && args[2]) {
  addAccount(args[1], args[2]);
} else if (args[0] === 'list') {
  const accounts = loadAccounts();
  accounts.forEach(a => console.log(`${a.username} - Claims: ${a.claims} - Last: ${a.lastClaim || 'never'}`));
} else {
  acquireLock();
  process.on('unhandledRejection', (e) => { log(`Unhandled rejection: ${e?.message || e}`); });
  process.on('uncaughtException', (e) => { log(`Uncaught: ${e?.message || e}`); });
  async function loop() {
    while (true) {
      try { await run(); } catch (e) { log(`ERROR: ${e.message.slice(0, 100)}`); await sleep(30000); }
    }
  }
  loop().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
