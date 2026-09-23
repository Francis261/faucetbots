import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'freelite-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

console.log('=== step 1: homepage ===');
await page.goto('https://freelitecoin.online/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[name="faucet_email"]', EMAIL);
console.log('email filled');

// wait up to 20s for turnstile widget to render any iframe
let tw = null;
for (let i = 0; i < 20 && !tw; i++) {
  tw = await page.evaluate(() => {
    const w = document.querySelector('.cf-turnstile iframe');
    return w ? { src: w.src.slice(0, 100) } : null;
  }).catch(() => null);
  if (!tw) await page.waitForTimeout(1000);
}
console.log('turnstile widget:', JSON.stringify(tw));

// dump the captcha container HTML
const capHtml = await page.evaluate(() => {
  const el = document.querySelector('.captcha-wrap');
  return el ? el.innerHTML.slice(0, 1500) : 'no .captcha-wrap';
});
console.log('captcha-wrap html:', capHtml);

console.log('=== step 3: mine.php ===');
await page.goto('https://freelitecoin.online/mine.php', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
console.log('mine url:', page.url());
const mineText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 600);
console.log('mine text:', mineText.replace(/\n+/g, ' | '));
const mineButtons = await page.evaluate(() => [...document.querySelectorAll('button, a, input[type=submit]')].map(b => ({
  tag: b.tagName, text: (b.innerText || (b.value||'') || '').trim().slice(0, 40), id: b.id, cls: (b.className||'').slice(0, 40), onclick: (b.getAttribute('onclick')||'').slice(0, 80),
})).slice(0, 25));
console.log('mine buttons:', JSON.stringify(mineButtons, null, 1));

console.log('=== step 4: dashboard.php ===');
await page.goto('https://freelitecoin.online/dashboard.php', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
console.log('dash url:', page.url());
const dashText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 500);
console.log('dash text:', dashText.replace(/\n+/g, ' | '));
const dashButtons = await page.evaluate(() => [...document.querySelectorAll('button, a, input[type=submit]')].map(b => ({
  tag: b.tagName, text: (b.innerText || (b.value||'') || '').trim().slice(0, 40), id: b.id, cls: (b.className||'').slice(0, 40), onclick: (b.getAttribute('onclick')||'').slice(0, 80),
})).slice(0, 25));
console.log('dash buttons:', JSON.stringify(dashButtons, null, 1));

await context.close();