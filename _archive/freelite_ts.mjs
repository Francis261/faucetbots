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

page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('  [console]', m.type(), m.text().slice(0, 150)); });
page.on('requestfailed', r => console.log('  [reqfail]', r.url().slice(0, 100), r.failure()?.errorText));

await page.goto('https://freelitecoin.online/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.fill('input[name="faucet_email"]', EMAIL);

// scroll the captcha into view, then wait up to 40s for a turnstile iframe
const wrap = page.locator('.captcha-wrap');
await wrap.scrollIntoViewIfNeeded().catch(() => {});
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const info = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile');
    const inner = el ? el.innerHTML : '';
    const iframes = [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 60));
    return { inner: inner.slice(0, 300), iframes };
  });
  const hasTs = info.iframes.some(s => s.includes('challenges.cloudflare.com'));
  console.log(`  [poll ${i}] turnstile iframe: ${hasTs ? 'YES' : 'no'}`);
  if (hasTs) break;
}

// dump the widget area fully
const finalInfo = await page.evaluate(() => {
  const el = document.querySelector('.cf-turnstile');
  return { outer: el ? el.outerHTML.slice(0, 2000) : 'none' };
});
console.log('turnstile outerHTML:', finalInfo.outer);

// try clicking the widget to trigger the checkbox/challenge
const cc = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
if (cc) {
  console.log('turnstile frame found:', cc.url().slice(0, 100));
  const bodyText = await cc.evaluate(() => document.body?.innerText || '').catch(() => '');
  console.log('frame text:', JSON.stringify(bodyText.slice(0, 200)));
  const clicked = await cc.click('body', { position: { x: 100, y: 100 }, force: true }).catch(e => 'err ' + e.message.slice(0, 60));
  console.log('click result:', clicked || 'clicked');
  await page.waitForTimeout(3000);
  const token = await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '');
  console.log('turnstile token len:', token.length);
}

await context.close();