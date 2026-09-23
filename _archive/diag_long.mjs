import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
const context = await browser.newContext({});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(10000);
  console.log(`--- ${(i + 1) * 10}s ---`);
  for (const f of page.frames()) {
    if (/challenges\.cloudflare\.com|turnstile/i.test(f.url())) {
      const info = await f.evaluate(() => {
        const b = document.body;
        return {
          text: b ? b.innerText.slice(0, 150) : 'none',
          childCount: b ? b.children.length : -1,
          html: b ? b.innerHTML.slice(0, 600) : 'none',
        };
      }).catch(e => ({ err: e.message.slice(0, 100) }));
      console.log('frame:', f.url().slice(-60), JSON.stringify(info).slice(0, 800));
    }
  }
}
await browser.close();
