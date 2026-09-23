import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
page.on('response', r => {
  if (r.url().includes('challenge-platform')) console.log('[resp]', r.status(), r.url().slice(0, 90));
});
await page.goto('https://adbtc.top/', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(10000);
  console.log(`--- ${(i + 1) * 10}s ---`);
  const title = await page.title();
  console.log('title:', title);
  if (!title.includes('Just a moment')) break;
  for (const f of page.frames()) {
    if (/challenges\.cloudflare\.com|turnstile/i.test(f.url())) {
      const info = await f.evaluate(() => {
        const b = document.body;
        return { text: b ? b.innerText.slice(0, 120) : 'none', childCount: b ? b.children.length : -1 };
      }).catch(e => ({ err: e.message.slice(0, 80) }));
      console.log('frame:', f.url().slice(-50), JSON.stringify(info));
    }
  }
}
await browser.close();
