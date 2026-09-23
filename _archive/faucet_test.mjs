import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const USE_PROFILE = process.argv.includes('--profile');
const PROFILE = '/home/francis/.config/google-chrome';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));

const context = await chromium.launchPersistentContext(
  USE_PROFILE ? PROFILE : TEMP,
  {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1366, height: 768 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  }
);
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = context.pages()[0] || (await context.newPage());

console.log('Opening tether-faucet...');
await page.goto('https://claimfreecoins.io/tether-faucet/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

await page.fill('input#address', EMAIL);
console.log('Filled email.');

console.log('Clicking Login button...');
await page.click('button[data-target="#captchaModal"]');
await page.waitForTimeout(3000);

console.log('Looking for recaptcha frames...');
for (const f of page.frames()) {
  if (/recaptcha|google\.com/.test(f.url())) {
    console.log('  frame:', f.url().slice(0, 90));
  }
}

// Try to click the recaptcha checkbox
const anchorFrame = page.frames().find(f => /api2\/anchor/.test(f.url()));
if (anchorFrame) {
  console.log('  anchor frame found. Clicking checkbox...');
  const cb = anchorFrame.locator('.recaptcha-checkbox');
  console.log('  checkbox count:', await cb.count());
  await cb.click({ timeout: 5000 }).catch(e => console.log('  click error:', e.message.slice(0, 100)));
  await page.waitForTimeout(8000);
  // Check state
  const state = await anchorFrame.locator('.recaptcha-checkbox-checked').count();
  const response = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
  console.log('  checkbox checked class count:', state);
  console.log('  g-recaptcha-response:', response ? 'POPULATED (' + response.length + ' chars)' : 'EMPTY');
} else {
  console.log('  NO anchor frame found');
}

await page.screenshot({ path: 'faucet.png' }).catch(() => {});
await context.close();
