import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ proxy: { server: 'socks5://127.0.0.1:1081' } });
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
let found = false;
for (const f of page.frames()) {
  if (f.url().includes('turnstile')) {
    found = true;
    try {
      const info = await f.evaluate(() => ({
        bodyHtml: document.body ? document.body.innerHTML.slice(0, 2000) : 'no body',
        bodyText: document.body ? document.body.innerText : 'no body',
      }));
      console.log('=== turnstile frame content ===');
      console.log(JSON.stringify(info, null, 2).slice(0, 3000));
    } catch (e) {
      console.log('frame evaluate error:', e.message.slice(0, 200));
    }
  }
}
if (!found) console.log('no turnstile frame found');
await browser.close();
