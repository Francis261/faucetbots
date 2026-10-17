#!/usr/bin/env node
// MoonPTC faucet bot
//
// Flow (per round):
//   1. ensure session (first run: homepage -> email -> "Start Earning")
//   2. /faucet -> status API -> claimable?
//   3. click "I'm not a robot" -> rotation captcha modal opens
//   4. capture the challenge over the network, solve the angle with solver.py
//      (pixel-match the pre-rotated cut-out against the base image; server
//      tolerance is +-10 degrees)
//   5. drive the slider -> verify -> token -> click "Claim Now"
//   6. log reward, wait out the cooldown, repeat
//
// Notes:
//   - anti_adblock is ENABLED on the site: ad requests must succeed or the
//     faucet refuses to claim, so ads are never blocked — popup tabs they
//     open are just closed.
//   - errors retry immediately; a 429 waits out locked_until.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EMAIL = process.env.MOONPTC_EMAIL || 'francisdominic261@gmail.com';
const SITE = 'https://moonptc.com';
const PROFILE_DIR = process.env.MOONPTC_PROFILE || join(process.env.HOME, '.moonptc-profile');
const SHOT_DIR = process.env.MOONPTC_SHOTS || '/tmp/moonptc-shots';
const HEADLESS = process.env.HEADLESS === '1';

mkdirSync(SHOT_DIR, { recursive: true });

// stdout is redirected to bot.log by the launcher — single writer, no dupes
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- rotation captcha solver ----------

async function solveAngle(page, challenge) {
  // fetch both images in the authenticated page context, then brute-force
  // the rotation angle offline with solver.py
  const data = await page.evaluate(async ({ variantUrl }) => {
    const grab = async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      const b = await r.arrayBuffer();
      let s = '';
      const bytes = new Uint8Array(b);
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s);
    };
    return { variant: await grab(variantUrl), base: await grab('/captcha/moon-base.webp') };
  }, { variantUrl: challenge.image });

  const varPath = join(SHOT_DIR, 'variant.webp');
  const basePath = join(SHOT_DIR, 'moon-base.webp');
  writeFileSync(varPath, Buffer.from(data.variant, 'base64'));
  writeFileSync(basePath, Buffer.from(data.base, 'base64'));

  const out = execFileSync('python3', [
    join(import.meta.dirname, 'solver.py'), basePath, varPath, JSON.stringify(challenge.crop),
  ], { encoding: 'utf8', timeout: 60000 });
  const res = JSON.parse(out.trim());
  log(`Solved angle ${res.angle}° (mse ${Math.round(res.mse)} vs median ${Math.round(res.mse_median)}, ${res.within_tolerance} angle(s) in near-tie)`);
  if (res.within_tolerance > 12) log('WARNING: flat match — image may be low contrast, relying on +-10° server tolerance');
  return res.angle;
}

// ---------- captcha interaction ----------

async function solveCaptchaUI(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    // capture the challenge the modal fetches when the button is clicked.
    // .catch(null) up front: if the click path fails, the abandoned waiter
    // must never become an unhandled rejection (it killed the process before)
    const challengeP = page.waitForResponse(
      (r) => r.url().includes('/rotation-captcha/challenge') && r.request().method() === 'POST',
      { timeout: 30000 },
    ).catch(() => null);
    // JS click: the ccnsad overlay div sits above the page and eats physical
    // pointer events — el.click() bypasses hit-testing entirely
    await page.getByRole('button', { name: "I'm not a robot" }).first().evaluate((el) => el.click());
    const chRes = await challengeP;
    if (!chRes) {
      log('Challenge fetch timed out — retrying');
      await sleep(2000);
      continue;
    }
    const chJson = await chRes.json();
    if (!chJson.session_id || !chJson.challenge) {
      log(`Challenge fetch failed: ${JSON.stringify(chJson).slice(0, 150)}`);
      return null;
    }
    log(`Challenge ${chJson.challenge.id.slice(0, 8)} crop=(${chJson.challenge.crop.x}, ${chJson.challenge.crop.y}, r=${chJson.challenge.crop.radius}) tol=${chJson.tolerance}`);

    const angle = await solveAngle(page, chJson.challenge);

    // drive the React-controlled range input, then fire keyup -> verify()
    const verifyP = page.waitForResponse(
      (r) => r.url().includes('/rotation-captcha/verify') && r.request().method() === 'POST',
      { timeout: 30000 },
    ).catch(() => null);
    await page.$eval('input[type="range"]', (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(angle));
    await sleep(350);
    await page.$eval('input[type="range"]',
      (el) => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })));

    const vRes = await verifyP;
    if (!vRes) {
      log('Verify fetch timed out — retrying');
      await sleep(2000);
      continue;
    }
    const vJson = await vRes.json();
    if (vJson.ok) {
      log(`Captcha verified (token ${String(vJson.token || '').slice(0, 18)}...)`);
      return vJson.token;
    }
    log(`Verify failed: ${JSON.stringify(vJson).slice(0, 150)}`);
    if (vJson.error === 'rate_limited' || vJson.error === 'blocked') {
      const wait = Number(vJson.retry_after || vJson.locked_until && 30) || 30;
      log(`Rate limited — waiting ${wait}s before a new challenge`);
      await sleep(wait * 1000);
    }
    // wrong/expired: the UI auto-loads a fresh challenge after ~1s
    await sleep(1800);
  }
  return null;
}

// ---------- main ----------

async function ensureLogin(page) {
  // 'commit' + explicit waits: domcontentloaded can hang behind slow ad/beacon
  // scripts even though the app is already rendered
  await page.goto(SITE + '/', { waitUntil: 'commit', timeout: 45000 });
  await sleep(2500);
  const st = await page.evaluate(async () => {
    const r = await fetch('/api/faucet/status', { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }).catch(() => null);
  if (st && st.status === 200 && st.body && !st.body.error) {
    log('Session already active — skipping login');
    return true;
  }
  log(`Logging in as ${EMAIL}...`);
  // two inputs share the placeholder (hero + footer CTA form) — the hero one
  // is first in the DOM; .first() avoids the strict-mode violation
  await page.getByPlaceholder(/FaucetPay email/i).first().fill(EMAIL);
  await Promise.all([
    page.waitForURL(/\/dashboard/, { timeout: 30000 }).catch(() => {}),
    page.getByRole('button', { name: 'Start Earning', exact: true }).first().evaluate((el) => el.click()),
  ]);
  await sleep(1500);
  const ok = page.url().includes('dashboard');
  log(ok ? 'Logged in' : `Login: unexpected landing at ${page.url()}`);
  return ok;
}

async function claimOnce(page) {
  await page.goto(SITE + '/faucet', { waitUntil: 'commit', timeout: 45000 });
  await sleep(3000);

  const status = await page.evaluate(async () =>
    (await fetch('/api/faucet/status', { credentials: 'include' })).json().catch(() => null));
  if (!status) return { retryIn: 15 };

  if (!status.canClaim) {
    return { retryIn: Math.max(3, status.remainingSeconds || 15) };
  }

  const token = await solveCaptchaUI(page);
  if (!token) return { retryIn: 10 };

  // Claim Now button (enabled once the captcha token is set). JS click again —
  // the ad overlay intercepts physical clicks on the faucet page.
  const claimP = page.waitForResponse(
    (r) => r.url().includes('/api/faucet/claim') && r.request().method() === 'POST',
    { timeout: 30000 },
  ).catch(() => null);
  await page.getByRole('button', { name: /claim now/i }).first().evaluate((el) => el.click());
  const cRes = await claimP;
  if (!cRes) {
    log('Claim response timed out');
    return { retryIn: 10 };
  }
  const cJson = await cRes.json().catch(() => ({}));

  if (cJson.ok) {
    log(`CLAIMED +${cJson.finalReward} coins (rolled ${cJson.roll})`);
    return { claimed: true, reward: cJson.finalReward, retryIn: (status.cooldownMinutes || 2) * 60 + 8 };
  }
  if (cJson.error === 'cooldown') {
    return { retryIn: Math.max(3, cJson.remainingSeconds || 60) };
  }
  log(`Claim failed: ${JSON.stringify(cJson).slice(0, 150)}`);
  return { retryIn: 10 };
}

async function main() {
  log('=== MoonPTC Faucet Bot started ===');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] || await context.newPage();

  // popunders/ads: never block (anti-adblock would block claims) — just close
  // the extra tabs they open, and dismiss any dialogs
  context.on('page', (p) => {
    if (p !== page) { p.close().catch(() => {}); log('Closed popup tab'); }
  });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  let loggedIn = false;
  let total = 0;
  let claims = 0;

  for (;;) {
    try {
      if (!loggedIn) loggedIn = await ensureLogin(page);
      if (!loggedIn) { await sleep(10000); continue; }

      const res = await claimOnce(page);
      if (res.claimed) {
        claims++;
        total += res.reward;
        log(`Session total: ${claims} claim(s), ${total} coins`);
      }
      const wait = res.retryIn ?? 60;
      log(wait > 20 ? `Cooldown: waiting ${wait}s` : `Retrying in ${wait}s`);
      await sleep(wait * 1000);
    } catch (err) {
      log(`Error: ${String(err).message || err}. Retrying in 10s...`);
      try { await page.screenshot({ path: join(SHOT_DIR, `err-${Date.now()}.png`) }); } catch {}
      await sleep(10000);
    }
  }
}

main().catch((e) => { log(`Fatal: ${e}`); process.exit(1); });
