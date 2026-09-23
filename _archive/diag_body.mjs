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
  await page.waitForTimeout(5000);
  console.log(`--- iter ${i + 1} ---`);
  for (const f of page.frames()) {
    if (/challenges\.cloudflare\.com|turnstile/i.test(f.url())) {
      try {
        const info = await f.evaluate(() => {
          const b = document.body;
          return {
            text: b ? b.innerText.slice(0, 500) : 'no body',
            children: b ? [...b.children].map(c => c.outerHTML.slice(0, 400)) : [],
          };
        });
        console.log('TEXT:', info.text);
        console.log('CHILDREN:', JSON.stringify(info.children, null, 1).slice(0, 3000));
      } catch (e) {
        console.log('eval err:', e.message.slice(0, 150));
      }
    }
  }
}
await browser.close();
