import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const URL = 'https://claimfreecoins.io/tether-faucet/';
const USE_PROFILE = process.argv.includes('--profile');
const PROFILE = '/home/francis/.config/google-chrome';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));
const ROUNDS = parseInt(process.argv.find(a => a.startsWith('--rounds='))?.split('=')[1] || '1', 10);
const INTERVAL_SEC = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '60', 10);

const context = await chromium.launchPersistentContext(USE_PROFILE ? PROFILE : TEMP, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1366, height: 768 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = context.pages()[0] || (await context.newPage());

function fmt(t) {
  return new Date(t).toLocaleTimeString('en-GB');
}

async function openModal() {
  await page.click('button[data-target="#captchaModal"]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const visible = await page.locator('#captchaModal').isVisible().catch(() => false);
  if (!visible) {
    await page.evaluate(() => {
      const m = document.querySelector('#captchaModal');
      if (m) {
        m.classList.add('show');
        m.style.display = 'block';
        m.style.paddingRight = '17px';
        m.setAttribute('role', 'dialog');
        m.setAttribute('aria-modal', 'true');
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop fade show';
        document.body.appendChild(backdrop);
      }
    });
    await page.waitForTimeout(500);
  }
  const after = await page.locator('#captchaModal').isVisible().catch(() => false);
  console.log(`[${fmt(Date.now())}] modal visible: ${after}`);
  return after;
}

async function clickRecaptchaCheckbox() {
  const frame = page.frames().find(f => /api2\/anchor/.test(f.url()));
  if (!frame) {
    console.log(`[${fmt(Date.now())}] no recaptcha anchor frame`);
    return false;
  }
  const cb = frame.locator('.recaptcha-checkbox').first();
  if ((await cb.count()) === 0) {
    console.log(`[${fmt(Date.now())}] recaptcha checkbox not present`);
    return false;
  }
  const alreadyChecked = (await frame.locator('.recaptcha-checkbox-checked').count()) > 0;
  if (alreadyChecked) {
    console.log(`[${fmt(Date.now())}] already checked`);
    return true;
  }
  await cb.click({ timeout: 5000 }).catch(e => console.log(`[${fmt(Date.now())}] checkbox click err: ${e.message.slice(0, 80)}`));
  return true;
}

async function recaptchaIsGood() {
  const frame = page.frames().find(f => /api2\/anchor/.test(f.url()));
  if (frame) {
    const checked = (await frame.locator('.recaptcha-checkbox-checked').count()) > 0;
    if (checked) return true;
  }
  const resp = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
  return resp.length > 20;
}

async function waitForRecaptchaGood(timeoutSec = 30) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    if (await recaptchaIsGood()) return true;
    await clickRecaptchaCheckbox();
    await page.waitForTimeout(2000);
  }
  return false;
}

async function claimOnce(round) {
  console.log(`[${fmt(Date.now())}] === Round ${round}: loading ${URL} ===`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  await page.fill('input#address', EMAIL);
  console.log(`[${fmt(Date.now())}] email entered. Opening modal...`);
  await openModal();

  console.log(`[${fmt(Date.now())}] clicking recaptcha checkbox...`);
  await waitForRecaptchaGood(30);
  if (await recaptchaIsGood()) {
    console.log(`[${fmt(Date.now())}] recaptcha GOOD. Clicking Verify Captcha...`);
    await page.click('input#login', { timeout: 10000 }).catch(e => console.log(`[${fmt(Date.now())}] verify click err: ${e.message.slice(0, 80)}`));
  } else {
    console.log(`[${fmt(Date.now())}] recaptcha did NOT become good`);
  }

  await page.waitForTimeout(6000);
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const snippets = text.split('\n').filter(l => l.trim().length > 2 && l.trim().length < 120).slice(-25);
  console.log(`[${fmt(Date.now())}] --- page text tail ---`);
  for (const s of snippets) console.log('   ', s.trim());
}

console.log(`[${fmt(Date.now())}] Starting faucet bot: ${ROUNDS} rounds, ${INTERVAL_SEC}s interval`);
for (let r = 1; r <= ROUNDS; r++) {
  try {
    await claimOnce(r);
  } catch (err) {
    console.log(`[${fmt(Date.now())}] ERROR round ${r}: ${err.message.slice(0, 200)}`);
  }
  if (r < ROUNDS) {
    console.log(`[${fmt(Date.now())}] waiting ${INTERVAL_SEC}s before next round...`);
    await page.waitForTimeout(INTERVAL_SEC * 1000);
  }
}
await context.close();
console.log(`[${fmt(Date.now())}] DONE`);
