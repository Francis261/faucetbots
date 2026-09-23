import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getAvailableAccount, markClaimed, markError, getAccountStats,
  getNextRetryTime, getDB
} from '../shared/accounts_db.mjs';

const config = JSON.parse(readFileSync(new URL('claimfreecoins_config.json', import.meta.url), 'utf8'));
const FAUCET_URL = config.url;

// Reusable Chrome profile
const PROFILE = join(process.env.HOME, '.claimfreecoins-chrome-profile');
mkdirSync(PROFILE, { recursive: true });

const BUSTER_EXT = join(process.env.HOME, 'adbch/extensions/buster');

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    `--disable-extensions-except=${BUSTER_EXT}`,
    `--load-extension=${BUSTER_EXT}`,
  ],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

function fmt(t) { return new Date(t).toLocaleTimeString('en-GB'); }
function log(msg) { console.log(`[${fmt(Date.now())}] ${msg}`); }

// Vosk transcription helper
function transcribeAudio(audioUrl) {
  const pyOut = execFileSync('python3', [join(process.env.HOME, 'adbch/shared/audio_transcribe.py'), audioUrl], {
    encoding: 'utf8', timeout: 30000
  });
  return JSON.parse(pyOut.trim());
}

// --- reCAPTCHA helpers ---

async function getAnchorState() {
  const anchor = page.frames().find(f => /api2\/anchor/.test(f.url()));
  if (!anchor) return { found: false };
  const txt = await anchor.evaluate(() => document.body.innerText || '').catch(() => '');
  const checked = (await anchor.locator('.recaptcha-checkbox-checked').count().catch(() => 0)) > 0;
  return { found: true, quota: txt.includes('exceeding reCAPTCHA'), checked, text: txt };
}

async function clickCheckboxAndObserve(timeoutSec = 40) {
  let anchor = page.frames().find(f => /api2\/anchor/.test(f.url()));
  for (let i = 0; i < 15 && !anchor; i++) {
    await page.waitForTimeout(1000);
    anchor = page.frames().find(f => /api2\/anchor/.test(f.url()));
  }
  log(`anchor frame: ${anchor ? 'found' : 'MISSING'}`);
  if (anchor) {
    let cbRect = null;
    for (let i = 0; i < 10 && !cbRect; i++) {
      cbRect = await anchor.evaluate(() => {
        const box = document.querySelector('#recaptcha-anchor') || document.querySelector('.recaptcha-checkbox');
        if (!box) return null;
        const r = box.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }).catch(() => null);
      if (!cbRect) await page.waitForTimeout(1000);
    }
    log(`checkbox rect: ${cbRect ? JSON.stringify(cbRect) : 'MISSING'}`);
    if (cbRect) {
      const frameEl = await page.evaluate(() => {
        for (const f of [...document.querySelectorAll('iframe')]) {
          if ((f.src || '').includes('api2/anchor')) {
            const r = f.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
        }
        return null;
      });
      if (frameEl) {
        const cx = frameEl.x + cbRect.x + cbRect.w / 2;
        const cy = frameEl.y + cbRect.y + cbRect.h / 2;
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(200);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        log(`clicked checkbox at ${cx.toFixed(0)},${cy.toFixed(0)}`);
      }
    }
  }
  const start = Date.now();
  let quotaStreak = 0;
  while (Date.now() - start < timeoutSec * 1000) {
    const st = await getAnchorState();
    const resp = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
    const bframeNow = page.frames().find(f => /api2\/bframe/.test(f.url()));
    const tileCount = bframeNow ? await bframeNow.locator('.rc-imageselect-table, .rc-image-tile-target').count().catch(() => 0) : 0;
    if (tileCount > 0) return 'challenge';
    if (st.checked && resp.length > 20) return 'passed';
    if (st.checked) {
      await page.waitForTimeout(1200);
      const resp2 = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
      if (resp2.length > 20) return 'passed';
    }
    if (st.quota) { quotaStreak++; if (quotaStreak >= 6) return 'quota'; }
    else { quotaStreak = 0; }
    await page.waitForTimeout(1000);
  }
  return 'timeout';
}

async function solveAudioChallenge() {
  const bframe = page.frames().find(f => /api2\/bframe/.test(f.url()));
  if (!bframe) return false;

  log('switching to audio challenge...');
  await bframe.evaluate(() => {
    const btn = document.querySelector('#recaptcha-audio-button');
    if (btn) btn.click();
  });
  await page.waitForTimeout(3000);

  const audioUrl = await bframe.evaluate(() => {
    const src = document.querySelector('#audio-source');
    return src ? src.src : null;
  }).catch(() => null);
  log(`audio URL: ${audioUrl ? audioUrl.slice(0, 80) : 'MISSING'}`);

  if (!audioUrl) return false;

  const pyResult = transcribeAudio(audioUrl);
  log(`transcription: ${JSON.stringify(pyResult)}`);

  if (!pyResult.text) return false;

  await bframe.evaluate((text) => {
    const input = document.querySelector('#audio-response');
    if (input) {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, pyResult.text);
  await page.waitForTimeout(500);

  await bframe.evaluate(() => {
    const btn = document.querySelector('#recaptcha-verify-button');
    if (btn) btn.click();
  });
  await page.waitForTimeout(3000);

  const resp = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
  return resp.length > 20;
}

async function submitClaim() {
  let resp = '';
  for (let i = 0; i < 10 && resp.length <= 20; i++) {
    resp = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
    if (resp.length <= 20) await page.waitForTimeout(1000);
  }
  log(`token length: ${resp.length}`);
  const btn = page.locator('input#login, #login').first();
  await btn.click({ force: true, timeout: 10000 }).catch(e => log(`verify click err: ${e.message.slice(0, 60)}`));
  await page.waitForTimeout(6000);
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const lines = text.split('\n').map(s => s.trim()).filter(s => s.length > 3 && s.length < 140).slice(-12);
  log('--- page tail ---');
  for (const l of lines) log(`  ${l}`);

  // Check result
  if (/was sent to your|claim success|successfully|credited/i.test(text)) {
    return { ok: true, msg: 'SUCCESS' };
  }
  if (/daily claim limit|come back tomorrow|already claimed/i.test(text)) {
    return { ok: false, msg: 'DAILY_LIMIT' };
  }
  if (/error|failed|invalid/i.test(text)) {
    return { ok: false, msg: 'ERROR' };
  }
  return { ok: false, msg: 'UNKNOWN' };
}

// --- Main bot loop ---

async function claimForAccount(account) {
  log(`--- Claiming for: ${account.email} ---`);

  // Navigate and fill email
  log('navigating to page...');
  await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for Cloudflare challenge to pass
  log('waiting for Cloudflare...');
  for (let i = 0; i < 30; i++) {
    const title = await page.title().catch(() => '');
    if (!title.includes('moment') && !title.includes('Checking') && !title.includes('Cloudflare')) {
      log(`page loaded: ${title}`);
      break;
    }
    await page.waitForTimeout(2000);
    if (i % 5 === 4) log(`still waiting for Cloudflare... (${(i+1)*2}s)`);
  }
  await page.waitForTimeout(2000);

  // Check if daily limit already reached (form won't be present)
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/daily claim limit|come back tomorrow|already claimed/i.test(bodyText)) {
    log('daily limit already reached for this account');
    return { ok: false, msg: 'DAILY_LIMIT' };
  }

  // Check if email input exists
  const hasInput = await page.locator('input#address').count().catch(() => 0);
  if (hasInput === 0) {
    log('email input not found — page may not have loaded correctly');
    return { ok: false, msg: 'PAGE_ERROR' };
  }

  await page.fill('input#address', account.email).catch(e => log(`fill err: ${e.message.slice(0, 40)}`));
  await page.click('button[data-target="#captchaModal"]', { timeout: 10000 }).catch(e => log(`modal click err: ${e.message.slice(0, 40)}`));
  await page.waitForTimeout(2000);

  // Ensure modal is visible
  const visible = await page.locator('#captchaModal').isVisible().catch(() => false);
  if (!visible) {
    await page.evaluate(() => {
      const m = document.querySelector('#captchaModal');
      if (m) {
        m.classList.add('show');
        m.style.display = 'block';
        const bd = document.createElement('div');
        bd.className = 'modal-backdrop fade show';
        document.body.appendChild(bd);
      }
    });
    await page.waitForTimeout(500);
  }

  // Solve reCAPTCHA
  const mode = await clickCheckboxAndObserve(45);
  log(`checkbox result: ${mode}`);

  if (mode === 'quota') {
    return { ok: false, msg: 'RECAPTCHA_QUOTA' };
  }

  if (mode === 'passed') {
    return await submitClaim();
  }

  if (mode === 'challenge') {
    const solved = await solveAudioChallenge();
    if (!solved) {
      log('audio challenge failed, waiting for manual solve...');
      const start = Date.now();
      while (Date.now() - start < 180000) {
        const resp = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
        if (resp.length > 20) break;
        if (!page.frames().find(f => /api2\/bframe/.test(f.url()))) break;
        await page.waitForTimeout(2000);
      }
    }
    return await submitClaim();
  }

  return { ok: false, msg: 'TIMEOUT' };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  log('=== ClaimFreeCoins Multi-Account Bot Started ===');

  // Ensure DB is initialized
  getDB();

  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  let round = 0;

  while (true) {
    round++;
    log(`\n=== Round ${round} ===`);

    const stats = getAccountStats();
    log(`Accounts: ${stats.total} total, ${stats.active} active, ${stats.cooldown} cooldown, ${stats.errors} errors`);

    const account = getAvailableAccount();

    if (!account) {
      const nextRetry = getNextRetryTime();
      if (nextRetry) {
        const retryDate = new Date(nextRetry);
        const waitMs = Math.max(retryDate.getTime() - Date.now(), 60000);
        log(`No accounts available. Next retry at ${retryDate.toLocaleString()} (waiting ${Math.round(waitMs / 60000)} min)`);
        await sleep(waitMs);
      } else {
        log('No accounts in database. Waiting 1 hour before recheck...');
        await sleep(CHECK_INTERVAL_MS);
      }
      continue;
    }

    try {
      const result = await claimForAccount(account);
      log(`Result for ${account.email}: ${result.msg}`);

      if (result.msg === 'SUCCESS') {
        markClaimed(account.email);
        log(`✓ ${account.email} claimed. Marked as cooldown until tomorrow.`);
      } else if (result.msg === 'DAILY_LIMIT') {
        markClaimed(account.email);
        log(`⏱ ${account.email} daily limit reached. Marked as cooldown until tomorrow.`);
      } else if (result.msg === 'RECAPTCHA_QUOTA') {
        log('reCAPTCHA quota exceeded. Waiting 5 minutes...');
        markError(account.email);
        await sleep(5 * 60 * 1000);
      } else {
        markError(account.email);
        log(`✗ ${account.email} failed (${result.msg}). Retrying in 5 min.`);
        await sleep(5 * 60 * 1000);
      }
    } catch (err) {
      log(`ERROR: ${err.message.slice(0, 200)}`);
      markError(account.email);
      await sleep(60000);
    }

    // Small delay between accounts
    await sleep(3000);
  }
}

await run();
