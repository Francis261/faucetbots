import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic986532@gmail.com';
const REFERRAL = 'https://freelitecoin.online/index.php?ref=24084';
const TEMP = mkdtempSync(join(tmpdir(), 'freelite-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto(REFERRAL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[name="faucet_email"]', EMAIL);

// solve turnstile
let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
if (ts) {
  for (let i = 0; i < 10; i++) {
    const htmlLen = await ts.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
    if (htmlLen > 0) break;
    await page.waitForTimeout(1000);
  }
  await ts.locator('body').click({ position: { x: 25, y: 33 }, timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

// check token before submit
const tokBefore = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
console.log('token before submit:', tokBefore);

// get the full form data
const formData = await page.evaluate(() => {
  const form = document.querySelector('form');
  const inputs = form ? [...form.querySelectorAll('input')].map(i => ({ name: i.name, value: i.value, type: i.type })) : [];
  return { action: form?.action, method: form?.method, inputs };
});
console.log('form data:', JSON.stringify(formData, null, 1));

// intercept the response
page.on('response', async (response) => {
  if (response.url().includes('freelitecoin.online') && response.request().method() === 'POST') {
    const body = await response.text().catch(() => '');
    console.log('POST response:', response.url().slice(0, 60), response.status());
    // look for error in body
    const errMatch = body.match(/Error[^<]*/i) || body.match(/error[^<]*/i);
    if (errMatch) console.log('error in response:', errMatch[0].slice(0, 100));
  }
});

// submit
await page.click('button[type="submit"]', { timeout: 10000 });
await page.waitForTimeout(5000);

console.log('after url:', page.url());
const bodyText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 800);
console.log('page text:', bodyText.replace(/\n+/g, ' | '));

// check for any error elements
const errorEls = await page.evaluate(() => {
  const els = document.querySelectorAll('.error, .alert, .message, [class*=error], [class*=alert], [class*=Error]');
  return [...els].map(e => ({ cls: e.className, text: e.innerText.trim().slice(0, 100) }));
});
console.log('error elements:', JSON.stringify(errorEls));

// check if there's a success message
const successEls = await page.evaluate(() => {
  const els = document.querySelectorAll('[class*=success], [class*=Success]');
  return [...els].map(e => ({ cls: e.className, text: e.innerText.trim().slice(0, 100) }));
});
console.log('success elements:', JSON.stringify(successEls));

await context.close();