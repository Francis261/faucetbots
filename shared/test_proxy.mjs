import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--host-resolver-rules=MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41',
  ],
});
const context = await browser.newContext({
  locale: 'en',
  viewport: { width: 1280, height: 800 },
  proxy: { server: 'socks5://127.0.0.1:1081' },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
page.on('requestfailed', r => console.log('[reqfail]', r.url().slice(0, 100), r.failure()?.errorText));
page.on('response', r => {
  if (r.url().includes('challenge-platform') || r.url().includes('brunhild'))
    console.log('[resp]', r.status(), r.url().slice(0, 110));
});
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(5000);
  const title = await page.title();
  const body = await page.locator('body').innerText();
  console.log(`t=${(i + 1) * 5}s title="${title}" body="${body.trim().slice(0, 50).replace(/\n/g, ' ')}"`);
  if (!title.includes('Just a moment') && !title.includes('moment')) break;
}
await browser.close();
