import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
const context = await browser.newContext({});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(5000);
  console.log(`--- iter ${i + 1} ---`);
  for (const f of page.frames()) {
    if (/challenges\.cloudflare\.com|turnstile/i.test(f.url())) {
      const info = await f.evaluate(() => {
        const b = document.body;
        const elems = b ? [...b.querySelectorAll('[role="checkbox"], input[type="checkbox"], label, [class*="checkbox"], .ctp-checkbox, [class*="challenge"]')].map(e => ({
          tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 60), role: e.getAttribute('role'),
        })) : [];
        return { text: b ? b.innerText.slice(0, 200) : 'none', elems };
      });
      console.log('TEXT:', info.text);
      console.log('ELEMS:', JSON.stringify(info.elems).slice(0, 1500));
    }
  }
}
await browser.close();
