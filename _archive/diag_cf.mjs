import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--host-resolver-rules=MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41',
  ],
});
const context = await browser.newContext({});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(4000);
  console.log(`--- iter ${i + 1} ---`);
  for (const f of page.frames()) {
    console.log('frame:', f.url().slice(0, 130));
    if (/challenges\.cloudflare\.com|turnstile/i.test(f.url())) {
      try {
        const info = await f.evaluate(() =>
          document.documentElement ? document.documentElement.outerHTML.slice(0, 3000) : 'none'
        );
        console.log(info);
      } catch (e) {
        console.log('  eval err:', e.message.slice(0, 100));
      }
    }
  }
}
await browser.close();
