import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--host-resolver-rules=MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41',
  ],
});
const context = await browser.newContext({});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
let clicked = false;
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(10000);
  console.log(`--- ${(i + 1) * 10}s ---`);
  for (const f of page.frames()) {
    if (/challenges\.cloudflare\.com|turnstile/i.test(f.url())) {
      const info = await f.evaluate(() => {
        const b = document.body;
        const els = b ? [...b.querySelectorAll('[role="checkbox"], input[type="checkbox"], .ctp-checkbox, label, button')] : [];
        return {
          text: b ? b.innerText.slice(0, 150) : 'none',
          childCount: b ? b.children.length : -1,
          checkboxes: els.length,
        };
      }).catch(e => ({ err: e.message.slice(0, 80) }));
      console.log('frame:', f.url().slice(-50), JSON.stringify(info));
      if (info.checkboxes > 0 && !clicked) {
        const cb = f.locator('[role="checkbox"], input[type="checkbox"], .ctp-checkbox').first();
        await cb.click({ force: true }).then(() => { clicked = true; console.log('>>> CLICKED checkbox'); });
      }
    }
  }
  const title = await page.title();
  if (!title.includes('Just a moment')) { console.log('>>> CHALLENGE CLEARED:', title); break; }
}
await browser.close();
