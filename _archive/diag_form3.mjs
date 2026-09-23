import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESOLVER = 'MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41';
const userDataDir = mkdtempSync(join(tmpdir(), 'adbch-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome', headless: false, viewport: { width: 1366, height: 768 }, locale: 'en-US',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--host-resolver-rules=${RESOLVER}`],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());
page.on('request', r => { if (r.url().includes('/index')) console.log('REQ', r.url()); });
page.on('response', r => { if (r.url().includes('/index') || r.status() === 403) console.log('RES', r.status(), r.url()); });

await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 40; i++) {
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (!title.includes('Just a moment') && !bodyText.includes('Performing security verification')) {
    console.log('CLEARED at iter', i + 1);
    break;
  }
  await page.waitForTimeout(5000);
}
console.log('FINAL URL:', page.url());
const info = await page.evaluate(() => ({
  url: location.href,
  text: (document.body?.innerText || '').slice(0, 600),
  html: document.documentElement?.outerHTML.slice(0, 3000),
}));
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'login3.png', fullPage: false }).catch(() => {});
await context.close();
