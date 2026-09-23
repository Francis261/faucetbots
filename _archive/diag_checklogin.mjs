import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';
const PROFILE = join(homedir(), '.config/google-chrome');
const RESOLVER = 'MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41';
const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport: { width: 1366, height: 768 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--host-resolver-rules=${RESOLVER}`],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());
await page.goto('https://adbtc.top/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 30; i++) {
  const title = await page.title().catch(() => '');
  if (!title.includes('Just a moment')) break;
  await page.waitForTimeout(5000);
}
console.log('URL:', page.url());
const info = await page.evaluate(() => ({ text: (document.body?.innerText || '').slice(0, 1200) }));
console.log(info.text);
await context.close();
