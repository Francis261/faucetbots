import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('freelitecoin_config.json', 'utf8'));
const EMAIL = config.email;
const REFERRAL = config.url;
const HOME = config.url;
const MINE = config.mine_url;
const DASH = config.dashboard_url;
const WITHDRAW_THRESHOLD = config.withdraw_threshold;
const TEMP = mkdtempSync(join(tmpdir(), 'freelitecoin-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

function fmt(t) { return new Date(t).toLocaleTimeString('en-GB'); }
function log(msg) { console.log(`[${fmt(Date.now())}] ${msg}`); }

// ---- Turnstile solver ----
async function solveTurnstile() {
  let ts;
  for (let i = 0; i < 15 && !ts; i++) {
    ts = page.frames().find(f => f.url().includes('turnstile'));
    if (!ts) await page.waitForTimeout(1000);
  }
  if (!ts) { log('  no turnstile frame'); return false; }
  // wait for frame to have some content
  for (let i = 0; i < 10; i++) {
    const htmlLen = await ts.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
    if (htmlLen > 0) break;
    await page.waitForTimeout(1000);
  }
  // click the checkbox at (25, 33) inside the turnstile frame
  await ts.locator('body').click({ position: { x: 25, y: 33 }, timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  log(`  turnstile token: ${tok}`);
  return tok > 20;
}

// ---- Homepage claim (login) ----
async function claimFaucet() {
  log('navigating to homepage...');
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.fill('input[name="faucet_email"]', EMAIL);
  const solved = await solveTurnstile();
  if (!solved) { log('  turnstile not solved'); return false; }
  await page.click('button[type="submit"]', { timeout: 10000 });
  await page.waitForTimeout(5000);
  const url = page.url();
  log(`  after claim: ${url}`);
  return url.includes('mine.php');
}

// ---- mine.php: get info ----
async function getMineInfo() {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    // Balance
    const balMatch = text.match(/Balance\s*([\d.]+)\s*LTC/);
    const balance = balMatch ? parseFloat(balMatch[1]) : 0;
    // Claims
    const claimsMatch = text.match(/Claims\s*(\d+)\/(\d+)/);
    const claimsUsed = claimsMatch ? parseInt(claimsMatch[1]) : 0;
    const claimsMax = claimsMatch ? parseInt(claimsMatch[2]) : 50;
    // Timer
    const timerMatch = text.match(/Next Reset Claims:\s*(\d+:\d+)/);
    const timer = timerMatch ? timerMatch[1] : '';
    // Roll result
    const rollMatch = text.match(/(\d{6})\s*$/m);
    const lastRoll = rollMatch ? rollMatch[1] : '';
    // ROLL button state
    const btn = document.querySelector('#mineButton');
    const btnDisabled = btn ? btn.disabled : true;
    const btnText = btn ? btn.innerText.trim() : '';
    return { balance, claimsUsed, claimsMax, timer, lastRoll, btnDisabled, btnText };
  }).catch(e => ({ err: e.message.slice(0, 100) }));
}

// ---- mine.php: click ROLL ----
async function clickRoll() {
  const btn = page.locator('#mineButton');
  const isDisabled = await btn.isDisabled().catch(() => true);
  const text = await btn.innerText().catch(() => '');
  if (isDisabled) return { clicked: false, reason: `disabled (${text})` };
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const info = await getMineInfo();
  return { clicked: true, ...info };
}

// ---- dashboard: get balance ----
async function getDashInfo() {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const balMatch = text.match(/Balance\s*([\d.]+)\s*LTC/i) || text.match(/([\d.]+)\s*LTC/);
    const balance = balMatch ? parseFloat(balMatch[1]) : 0;
    const amountInput = document.querySelector('#amount');
    const amountVal = amountInput ? parseFloat(amountInput.value) : 0;
    return { balance, amountVal };
  }).catch(e => ({ err: e.message.slice(0, 100) }));
}

// ---- dashboard: withdraw ----
async function doWithdraw() {
  // click Max button
  await page.locator('.max-btn').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  // click Withdraw button
  await page.locator('.btn-instant-withdraw').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const info = await getDashInfo();
  log(`  withdraw done, balance now: ${info.balance}`);
  return info;
}

// ---- Main loop ----
async function run() {
  log('=== FreeLitecoin Bot Started ===');
  log(`email: ${EMAIL}`);

  // Step 1: claim faucet to establish session
  let loggedIn = await claimFaucet();
  if (!loggedIn) {
    log('first claim failed, retrying in 30s...');
    await page.waitForTimeout(30000);
    loggedIn = await claimFaucet();
  }
  if (!loggedIn) { log('could not log in, exiting'); await context.close(); return; }
  log('logged in, session established');

  // Navigate to mine.php
  await page.goto(MINE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  let round = 0;
  while (true) {
    round++;
    try {
      const info = await getMineInfo();
      log(`--- round ${round} | balance: ${info.balance} | claims: ${info.claimsUsed}/${info.claimsMax} | timer: ${info.timer} | btn: ${info.btnText} ---`);

      // check if ROLL button is clickable
      if (!info.btnDisabled && info.btnText.toLowerCase().includes('roll')) {
        const result = await clickRoll();
        log(`  ROLL clicked! balance: ${result.balance}`);
      } else {
        log(`  ROLL not ready (${info.btnText || 'disabled'}), waiting 15s...`);
        await page.waitForTimeout(15000);
        continue;
      }

      // Check if claims exhausted
      if (info.claimsUsed >= info.claimsMax) {
        log(`  claims exhausted (${info.claimsUsed}/${info.claimsMax}), waiting for reset...`);
        // parse timer mm:ss
        const parts = info.timer.split(':');
        const waitSec = parts.length === 2 ? (parseInt(parts[0]) * 60 + parseInt(parts[1]) + 10) : 1800;
        log(`  waiting ${waitSec}s for claims reset`);
        await page.waitForTimeout(waitSec * 1000);
        // reload mine.php after wait
        await page.goto(MINE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);
        continue;
      }

      // Check balance for withdrawal
      if (info.balance >= WITHDRAW_THRESHOLD) {
        log(`  balance ${info.balance} >= ${WITHDRAW_THRESHOLD}, going to dashboard...`);
        await page.goto(DASH, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);
        const dashInfo = await getDashInfo();
        if (dashInfo.balance >= WITHDRAW_THRESHOLD) {
          log(`  withdrawing ${dashInfo.balance} LTC...`);
          await doWithdraw();
        }
        // go back to mine
        await page.goto(MINE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);
      }

      // wait before next roll
      await page.waitForTimeout(15000);

    } catch (err) {
      log(`  ERROR: ${err.message.slice(0, 200)}`);
      await page.waitForTimeout(15000);
    }
  }
}

run().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });