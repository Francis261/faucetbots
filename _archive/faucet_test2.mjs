import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1366, height: 768 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

page.on('response', r => {
  if (/recaptcha|google\.com|gstatic/.test(r.url())) console.log('RES', r.status(), r.url().slice(0, 90));
});

console.log('Opening...');
await page.goto('https://claimfreecoins.io/tether-faucet/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

const modalVisible = await page.locator('#captchaModal').isVisible().catch(() => false);
console.log('modal visible before click:', modalVisible);

await page.fill('input#address', EMAIL);
console.log('Clicking Login button...');
await page.click('button[data-target="#captchaModal"]');
await page.waitForTimeout(3000);

const modalVisible2 = await page.locator('#captchaModal').isVisible().catch(() => false);
console.log('modal visible after click:', modalVisible2);
console.log('modal classes:', await page.locator('#captchaModal').getAttribute('class').catch(() => 'n/a'));

console.log('--- all frames ---');
for (const f of page.frames()) console.log('  frame:', f.url().slice(0, 100));

const recaptchaCount = await page.locator('.g-recaptcha iframe, .g-recaptcha').count();
console.log('g-recaptcha element count:', recaptchaCount);

const recaptchaHTML = await page.evaluate(() => {
  const el = document.querySelector('.g-recaptcha');
  return el ? el.innerHTML.slice(0, 500) : 'NO .g-recaptcha';
});
console.log('.g-recaptcha innerHTML:', recaptchaHTML);

await page.screenshot({ path: 'faucet2.png' }).catch(() => {});
await context.close();
