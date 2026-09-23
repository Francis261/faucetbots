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
console.log('ts:', !!ts);
if (ts) {
  for (let i = 0; i < 10; i++) {
    const htmlLen = await ts.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
    if (htmlLen > 0) break;
    await page.waitForTimeout(1000);
  }
  await ts.locator('body').click({ position: { x: 25, y: 33 }, timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);
}
const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
console.log('token:', tok);

// check form before submit
const formInfo = await page.evaluate(() => {
  const form = document.querySelector('form');
  const inputs = form ? [...form.querySelectorAll('input')].map(i => ({ name: i.name, value: i.value.slice(0, 30), type: i.type })) : [];
  return { action: form?.action, method: form?.method, inputs };
});
console.log('form:', JSON.stringify(formInfo, null, 1));

// submit
await page.click('button[type="submit"]', { timeout: 10000 });
await page.waitForTimeout(5000);

console.log('after url:', page.url());
const bodyText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 500);
console.log('page text:', bodyText.replace(/\n+/g, ' | '));

// check for error messages
const errors = await page.evaluate(() => {
  const els = document.querySelectorAll('.error, .alert, .message, [class*=error], [class*=alert]');
  return [...els].map(e => e.innerText.trim().slice(0, 100));
});
console.log('errors:', errors);

// check if we have a session
const cookies = await context.cookies('https://freelitecoin.online');
console.log('cookies:', cookies.map(c => `${c.name}=${c.value.slice(0, 20)}`).join(', '));

// try going to mine.php
await page.goto('https://freelitecoin.online/mine.php', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('mine.php url:', page.url());
const mineText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 300);
console.log('mine text:', mineText.replace(/\n+/g, ' | '));

await context.close();