import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
const top = page.frames()[0];
const info = await top.evaluate(() => {
  const b = document.body;
  return {
    text: b ? b.innerText.slice(0, 300) : 'none',
    iframes: [...document.querySelectorAll('iframe')].map(f => ({ id: f.id, src: (f.src || '').slice(0, 100), w: f.width, h: f.height })),
    buttons: [...document.querySelectorAll('button, [role="button"], .turnstile-wrapper, [class*="turnstile"]')].map(e => ({ tag: e.tagName, cls: (e.className||'').toString().slice(0,60) })),
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
