#!/usr/bin/env node
// MoonPTC faucet bot — multi-account
//
// Reads accounts from moonptc-accounts.json (or $MOONPTC_ACCOUNTS_FILE):
//   [ "one@example.com", { "email": "two@example.com" } ]
// Each account gets its OWN Chrome profile ($MOONPTC_PROFILES_ROOT/<email>,
// default ~/.moonptc-profiles/<email>), its own browser window, its own
// balance tracking and its own withdraw cycle. Accounts run concurrently.
//
// Flow (per round, per account):
//   1. ensure session (first run: homepage -> email -> "Start Earning")
//   2. /faucet -> status API -> claimable?
//   3. click "I'm not a robot" -> rotation captcha modal opens
//   4. capture the challenge over the network, solve the angle with solver.py
//      (pixel-match the pre-rotated cut-out against the base image; server
//      tolerance is +-10 degrees)
//   5. drive the slider -> verify -> token -> click "Claim Now"
//   6. log reward, wait out the cooldown, repeat
//
// Withdrawal (per account): whenever the server balance reaches >= 100 coins,
// visit /withdraw, fill the WHOLE balance, select Tether (USDT), solve the
// Cloudflare Turnstile and press "Request withdrawal".  Failures back the
// withdraw gate off (cooldown/pending/errors) while the faucet keeps cycling.
//
// Notes:
//   - anti_adblock is ENABLED on the site: ad requests must succeed or the
//     faucet refuses to claim, so ads are never blocked — popup tabs they
//     open are just closed.
//   - errors retry immediately; a 429 waits out locked_until.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 'https://moonptc.com';
const ACCOUNTS_FILE = process.env.MOONPTC_ACCOUNTS_FILE || join(import.meta.dirname, 'moonptc-accounts.json');
const PROFILES_ROOT = process.env.MOONPTC_PROFILES_ROOT || join(process.env.HOME, '.moonptc-profiles');
const SHOT_ROOT = process.env.MOONPTC_SHOTS || '/tmp/moonptc-shots';
const HEADLESS = process.env.HEADLESS === '1';
// optional: use a system browser channel instead of Playwright's bundled
// chromium (e.g. MOONPTC_CHANNEL=chrome on CI where Google Chrome is installed)
const CHANNEL = process.env.MOONPTC_CHANNEL || '';
const WITHDRAW_MIN = 100; // site minimum, also the user-set trigger

// stdout is redirected to bot.log by the launcher — single writer, no dupes
const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sanitize = (email) => email.toLowerCase().replace(/[^a-z0-9]+/g, '_');

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  const emails = [];
  for (const entry of raw) {
    const email = typeof entry === 'string' ? entry : entry?.email;
    if (email && !emails.includes(email)) emails.push(email);
  }
  return emails;
}

function makeAccount(email) {
  const tag = email.split('@')[0];
  const acc = {
    email,
    tag,
    profileDir: join(PROFILES_ROOT, sanitize(email)),
    shotDir: join(SHOT_ROOT, sanitize(email)),
    context: null,
    page: null,
    loggedIn: false,
    withdrawBackoffUntil: 0,
    total: 0,
    claims: 0,
    log: (msg) => console.log(`[${ts()}] [${tag}] ${msg}`),
  };
  mkdirSync(acc.shotDir, { recursive: true });
  return acc;
}

// ---------- rotation captcha solver ----------

async function solveAngle(acc, challenge) {
  const page = acc.page;
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

  const varPath = join(acc.shotDir, 'variant.webp');
  const basePath = join(acc.shotDir, 'moon-base.webp');
  writeFileSync(varPath, Buffer.from(data.variant, 'base64'));
  writeFileSync(basePath, Buffer.from(data.base, 'base64'));

  const out = execFileSync('python3', [
    join(import.meta.dirname, 'solver.py'), basePath, varPath, JSON.stringify(challenge.crop),
  ], { encoding: 'utf8', timeout: 60000 });
  const res = JSON.parse(out.trim());
  acc.log(`Solved angle ${res.angle}° (mse ${Math.round(res.mse)} vs median ${Math.round(res.mse_median)}, ${res.within_tolerance} angle(s) in near-tie)`);
  if (res.within_tolerance > 12) acc.log('WARNING: flat match — image may be low contrast, relying on +-10° server tolerance');
  return res.angle;
}

// ---------- captcha interaction ----------

async function solveCaptchaUI(acc) {
  const page = acc.page;
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
      acc.log('Challenge fetch timed out — retrying');
      await sleep(2000);
      continue;
    }
    const chJson = await chRes.json();
    if (!chJson.session_id || !chJson.challenge) {
      acc.log(`Challenge fetch failed: ${JSON.stringify(chJson).slice(0, 150)}`);
      return null;
    }
    acc.log(`Challenge ${chJson.challenge.id.slice(0, 8)} crop=(${chJson.challenge.crop.x}, ${chJson.challenge.crop.y}, r=${chJson.challenge.crop.radius}) tol=${chJson.tolerance}`);

    const angle = await solveAngle(acc, chJson.challenge);

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
      acc.log('Verify fetch timed out — retrying');
      await sleep(2000);
      continue;
    }
    const vJson = await vRes.json();
    if (vJson.ok) {
      acc.log(`Captcha verified (token ${String(vJson.token || '').slice(0, 18)}...)`);
      return vJson.token;
    }
    acc.log(`Verify failed: ${JSON.stringify(vJson).slice(0, 150)}`);
    if (vJson.error === 'rate_limited' || vJson.error === 'blocked') {
      const wait = Number(vJson.retry_after || vJson.locked_until && 30) || 30;
      acc.log(`Rate limited — waiting ${wait}s before a new challenge`);
      await sleep(wait * 1000);
    }
    // wrong/expired: the UI auto-loads a fresh challenge after ~1s
    await sleep(1800);
  }
  return null;
}

// ---------- withdrawal ----------

async function getBalance(acc) {
  return acc.page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      return typeof j.user?.balance === 'number' ? j.user.balance : null;
    } catch { return null; }
  });
}

// The ccnsad overlay sits above everything and eats physical pointer events.
// Ads are never blocked (anti-adblock gates claiming) — we just make the
// overlay click-through (CSS rule survives re-injection, inline style covers
// the current nodes).
async function defuseOverlay(acc) {
  await acc.page.evaluate(() => {
    if (!document.getElementById('bot-defuse')) {
      const st = document.createElement('style');
      st.id = 'bot-defuse';
      st.textContent = '[data-cc-id]{pointer-events:none !important}';
      document.head.appendChild(st);
    }
    document.querySelectorAll('[data-cc-id]').forEach((d) => { d.style.pointerEvents = 'none'; });
  }).catch(() => {});
}

async function solveTurnstile(acc) {
  const page = acc.page;
  const token = () => page.evaluate(() =>
    document.querySelector('input[name="cf-turnstile-response"]')?.value || '').catch(() => '');
  const failed = () => page.evaluate(() =>
    /captcha verification failed/i.test(document.body.innerText)).catch(() => false);

  for (let cycle = 1; cycle <= 2; cycle++) {
    // locate the widget iframe (turnstile renders inside a shadow root, so we
    // go through page.frames() — document.querySelectorAll can't see it)
    let box = null;
    for (let i = 0; i < 25 && !box; i++) {
      const fr = page.frames().find((f) => (f.url() || '').includes('challenges.cloudflare.com'));
      if (fr) {
        const el = await fr.frameElement().catch(() => null);
        box = el ? await el.boundingBox().catch(() => null) : null;
        if (box && box.width <= 0) box = null;
      }
      if (!box) await sleep(1000);
    }
    if (!box) { acc.log('Turnstile widget not found'); return null; }
    acc.log(`Turnstile widget at (${Math.round(box.x)}, ${Math.round(box.y)}) [cycle ${cycle}]`);

    // managed widgets can auto-verify — short grace before clicking
    for (let t = 0; t < 5; t++) {
      await sleep(1500);
      const tok = await token();
      if (tok.length > 10) { acc.log('Turnstile auto-solved'); return tok; }
      if (await failed()) break;
    }
    if ((await token()).length > 10) return await token();

    // one realistic click on the checkbox
    const fr = page.frames().find((f) => (f.url() || '').includes('challenges.cloudflare.com'));
    const el = fr ? await fr.frameElement().catch(() => null) : null;
    const b = el ? await el.boundingBox().catch(() => null) : null;
    if (b) box = b;
    const x = box.x + 25, y = box.y + box.height / 2;
    acc.log(`Turnstile: clicking checkbox at (${Math.round(x)}, ${Math.round(y)})`);
    await defuseOverlay(acc);
    await page.mouse.move(x - 160, y - 110, { steps: 14 });
    await sleep(350);
    await page.mouse.move(x, y, { steps: 14 });
    await sleep(250);
    await page.mouse.click(x, y);

    for (let t = 0; t < 30; t++) {
      await sleep(1500);
      const tok = await token();
      if (tok.length > 10) { acc.log(`Turnstile solved (cycle ${cycle})`); return tok; }
      if (await failed()) break;
    }
    if ((await token()).length > 10) return await token();

    // verification failed — the site offers "Try again" (fresh widget)
    if (cycle < 2) {
      acc.log('Turnstile verification failed — retrying via "Try again"');
      const retry = page.getByText(/try again/i).first();
      if (await retry.count()) await retry.evaluate((el2) => el2.click()).catch(() => {});
      await sleep(3000);
    }
  }

  // failed — capture what the widget actually showed for diagnosis
  try { await page.screenshot({ path: join(acc.shotDir, `turnstile-fail-${Date.now()}.png`) }); } catch {}
  const diag = await page.evaluate(() => ({
    input: document.querySelector('input[name="cf-turnstile-response"]')?.value?.length || 0,
    failed: /captcha verification failed/i.test(document.body.innerText),
    submitDisabled: (() => {
      const b = [...document.querySelectorAll('button')].find((x) => /request withdraw/i.test(x.textContent || ''));
      return b ? b.disabled : 'not-found';
    })(),
  })).catch((e) => ({ err: String(e.message || e) }));
  acc.log(`Turnstile failed — diag: ${JSON.stringify(diag)}`);
  return null;
}

async function maybeWithdraw(acc, preBalance) {
  const page = acc.page;
  acc.log(`Balance ${preBalance} >= ${WITHDRAW_MIN} — going to withdraw...`);
  await page.goto(SITE + '/withdraw', { waitUntil: 'commit', timeout: 45000 });
  await sleep(3500);

  const info = await page.evaluate(async () =>
    (await fetch('/api/withdraw/info', { credentials: 'include' })).json().catch(() => null));
  if (!info) { acc.log('withdraw/info unavailable — backing off 10 min'); acc.withdrawBackoffUntil = Date.now() + 600000; return; }
  if ((info.cooldownRemaining || 0) > 0) {
    const secs = info.cooldownRemaining + 10;
    acc.log(`Withdraw cooldown: ${info.cooldownRemaining}s — will retry after`);
    acc.withdrawBackoffUntil = Date.now() + secs * 1000;
    return;
  }

  // fresh balance (claims may have landed between gate and page)
  const bal = (await getBalance(acc)) ?? preBalance;
  const minAmt = info.minAmount || WITHDRAW_MIN;
  const amount = Math.floor(bal);
  if (amount < minAmt) { acc.log(`Balance ${amount} < min ${minAmt} — not withdrawing`); return; }

  await defuseOverlay(acc);

  // 1. amount = whole available balance
  await page.$eval('input[type="number"]', (el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(amount));
  await sleep(300);

  // 2. Tether (the grid auto-preselects cryptos[0] — explicitly pick USDT)
  const tether = page.getByRole('button', { name: /tether|usdt/i }).first();
  if (await tether.count()) await tether.evaluate((el) => el.click());
  else acc.log('WARNING: Tether option not found');
  await sleep(300);

  // 3. Cloudflare Turnstile
  const token = await solveTurnstile(acc);
  if (!token) { acc.log('No turnstile token — backing off 10 min'); acc.withdrawBackoffUntil = Date.now() + 600000; return; }

  // give React a beat to enable the submit button, then click it
  await sleep(600);
  const submit = page.getByRole('button', { name: /request withdraw/i }).first();
  const disabled = await submit.evaluate((el) => el.disabled).catch(() => true);
  if (disabled) { acc.log('Submit still disabled after token — backing off 5 min'); acc.withdrawBackoffUntil = Date.now() + 300000; return; }

  const respP = page.waitForResponse(
    (r) => r.url().includes('/api/withdraw/request') && r.request().method() === 'POST',
    { timeout: 30000 },
  ).catch(() => null);
  await submit.evaluate((el) => el.click());
  const resp = await respP;
  if (!resp) { acc.log('Withdraw response timed out — backing off 10 min'); acc.withdrawBackoffUntil = Date.now() + 600000; return; }

  const j = await resp.json().catch(() => ({}));
  if (j.ok) {
    const msg = j.messageKey ? `${j.messageKey} ${JSON.stringify(j.messageParams || {})}` : 'pending review';
    acc.log(`WITHDREW ${amount} coins -> Tether (USDT) — ${msg}`);
    acc.withdrawBackoffUntil = Date.now() + 30 * 60000; // pending review — let it settle
  } else if (j.error === 'cooldown') {
    const mins = j.remainingMinutes || 10;
    acc.log(`Withdraw cooldown ${mins} min — backing off`);
    acc.withdrawBackoffUntil = Date.now() + (mins * 60 + 10) * 1000;
  } else if (j.error === 'pendingExists' || String(j.error || '').toLowerCase().includes('pending')) {
    acc.log('Withdrawal already pending — backing off 60 min');
    acc.withdrawBackoffUntil = Date.now() + 60 * 60000;
  } else {
    acc.log(`Withdraw failed: ${JSON.stringify(j).slice(0, 200)} — backing off 15 min`);
    acc.withdrawBackoffUntil = Date.now() + 15 * 60000;
  }
  try { await page.screenshot({ path: join(acc.shotDir, `withdraw-${Date.now()}.png`) }); } catch {}
}

// ---------- browser (one per account) ----------

async function openBrowser(acc) {
  if (acc.context) { try { await acc.context.close(); } catch {} }
  // stale singleton locks (from a SIGKILLed browser) block every relaunch
  mkdirSync(acc.profileDir, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { unlinkSync(join(acc.profileDir, f)); } catch {}
  }
  acc.context = await chromium.launchPersistentContext(acc.profileDir, {
    headless: HEADLESS,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
    viewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Cloudflare Turnstile rejects automation fingerprints — without these
      // the withdraw widget clicks but verification always ends in
      // "Captcha verification failed"
      '--disable-blink-features=AutomationControlled',
      // some hosts' DNS answers CF's brunhild/dnstest challenge hosts v6-only
      // (ERR_ADDRESS_UNREACHABLE kills the widget) — pin them to a working
      // Cloudflare edge IP. Harmless where the hosts resolve normally.
      '--host-resolver-rules=MAP brunhild.challenges.cloudflare.com 104.18.8.208,' +
      'MAP *.dnstest.challenges.cloudflare.com 104.18.9.208',
    ],
  });
  // hide navigator.webdriver (set by CDP automation) — required by Turnstile
  await acc.context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  acc.page = acc.context.pages()[0] || await acc.context.newPage();

  // popunders/ads: never block (anti-adblock would block claims) — just close
  // the extra tabs they open, and dismiss any dialogs
  acc.context.on('page', (p) => {
    if (p !== acc.page) { p.close().catch(() => {}); acc.log('Closed popup tab'); }
  });
  acc.page.on('dialog', (d) => d.dismiss().catch(() => {}));
  acc.log(`Browser ready (profile ${acc.profileDir})`);
}

async function ensureLogin(acc) {
  const page = acc.page;
  // 'commit' + explicit waits: domcontentloaded can hang behind slow ad/beacon
  // scripts even though the app is already rendered
  await page.goto(SITE + '/', { waitUntil: 'commit', timeout: 45000 });
  await sleep(2500);
  const st = await page.evaluate(async () => {
    const r = await fetch('/api/faucet/status', { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }).catch(() => null);
  if (st && st.status === 200 && st.body && !st.body.error) {
    acc.log('Session already active — skipping login');
    return true;
  }
  acc.log(`Logging in as ${acc.email}...`);
  // two inputs share the placeholder (hero + footer CTA form) — the hero one
  // is first in the DOM; .first() avoids the strict-mode violation
  await page.getByPlaceholder(/FaucetPay email/i).first().fill(acc.email);
  await Promise.all([
    page.waitForURL(/\/dashboard/, { timeout: 30000 }).catch(() => {}),
    page.getByRole('button', { name: 'Start Earning', exact: true }).first().evaluate((el) => el.click()),
  ]);
  await sleep(1500);
  const ok = page.url().includes('dashboard');
  acc.log(ok ? 'Logged in' : `Login: unexpected landing at ${page.url()}`);
  return ok;
}

async function claimOnce(acc) {
  const page = acc.page;
  await page.goto(SITE + '/faucet', { waitUntil: 'commit', timeout: 45000 });
  await sleep(3000);

  const status = await page.evaluate(async () =>
    (await fetch('/api/faucet/status', { credentials: 'include' })).json().catch(() => null));
  if (!status) return { retryIn: 15 };

  if (!status.canClaim) {
    return { retryIn: Math.max(3, status.remainingSeconds || 15) };
  }

  const token = await solveCaptchaUI(acc);
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
    acc.log('Claim response timed out');
    return { retryIn: 10 };
  }
  const cJson = await cRes.json().catch(() => ({}));

  if (cJson.ok) {
    acc.log(`CLAIMED +${cJson.finalReward} coins (rolled ${cJson.roll})`);
    return { claimed: true, reward: cJson.finalReward, retryIn: (status.cooldownMinutes || 2) * 60 + 8 };
  }
  if (cJson.error === 'cooldown') {
    return { retryIn: Math.max(3, cJson.remainingSeconds || 60) };
  }
  acc.log(`Claim failed: ${JSON.stringify(cJson).slice(0, 150)}`);
  return { retryIn: 10 };
}

// ---------- per-account main loop ----------

async function runAccount(acc) {
  // browser launch can fail transiently on a cold VM (browser download races,
  // X server not up yet) — retry forever with logging instead of letting the
  // whole process exit silently
  for (;;) {
    try {
      await openBrowser(acc);
      break;
    } catch (e) {
      acc.log(`Browser launch failed: ${e?.message || e} — retrying in 10s`);
      await sleep(10000);
    }
  }

  for (;;) {
    try {
      if (!acc.loggedIn) acc.loggedIn = await ensureLogin(acc);
      if (!acc.loggedIn) { await sleep(10000); continue; }

      // withdraw the whole balance once it reaches the minimum
      if (Date.now() >= acc.withdrawBackoffUntil) {
        const bal = await getBalance(acc);
        if (bal !== null && bal >= WITHDRAW_MIN) await maybeWithdraw(acc, bal);
      }

      const res = await claimOnce(acc);
      if (res.claimed) {
        acc.claims++;
        acc.total += res.reward;
        acc.log(`Session total: ${acc.claims} claim(s), ${acc.total} coins`);
      }
      const wait = res.retryIn ?? 60;
      acc.log(wait > 20 ? `Cooldown: waiting ${wait}s` : `Retrying in ${wait}s`);
      await sleep(wait * 1000);
    } catch (err) {
      const msg = String(err?.message || err).split('\n')[0];
      acc.log(`Error: ${msg}. Retrying in 10s...`);
      try { await acc.page.screenshot({ path: join(acc.shotDir, `err-${Date.now()}.png`) }); } catch {}
      // window closed / chromium crashed — relaunch the browser and re-check
      // the session (cookies persist in the profile)
      if (/browser has been closed|Target page, context|disconnected|Target closed/i.test(msg)) {
        acc.log('Browser is dead — relaunching...');
        await openBrowser(acc).catch((e) => acc.log(`Relaunch failed: ${String(e.message || e)}`));
        acc.loggedIn = false;
      }
      await sleep(10000);
    }
  }
}

// ---------- main ----------

async function main() {
  const emails = loadAccounts();
  if (!emails.length) {
    console.error(`[${ts()}] No accounts in ${ACCOUNTS_FILE}`);
    console.error('Add e.g. ["you@example.com", {"email":"second@example.com"}]');
    process.exit(1);
  }
  console.log(`[${ts()}] === MoonPTC Faucet Bot started — ${emails.length} account(s) ===`);
  const accounts = emails.map(makeAccount);
  // one independent loop per account; runAccount never resolves — and if it
  // somehow rejects, log it loudly instead of exiting silently
  await Promise.allSettled(accounts.map((a) => runAccount(a).catch((e) => {
    console.log(`[${ts()}] [${a.tag}] account loop crashed: ${e?.stack || e}`);
  })));
}

main().catch((e) => { console.log(`[${ts()}] Fatal: ${e}`); process.exit(1); });
