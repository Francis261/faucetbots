import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ proxy: { server: 'socks5://127.0.0.1:1081' } });
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
for (const f of page.frames()) {
  if (f.url().includes('turnstile')) {
    const html = await f.content().catch(() => 'ERR');
    console.log('=== turnstile frame HTML ===');
    console.log(html.slice(0, 2500));
  }
}
await browser.close();
