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
page.on('response', r => { if (r.url().includes('/index') || r.status() === 403) console.log('RES', r.status(), r.url().slice(0, 80)); });
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 40; i++) {
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (!title.includes('Just a moment') && !bodyText.includes('Performing security verification')) {
    console.log('CHALLENGE CLEARED at iter', i + 1);
    break;
  }
  await page.waitForTimeout(5000);
}
await page.waitForTimeout(3000);
console.log('URL:', page.url());
const info = await page.evaluate(() => ({
  title: document.title,
  text: (document.body?.innerText || '').slice(0, 400),
  forms: [...document.querySelectorAll('form')].map(f => ({ action: f.action, id: f.id })),
  inputs: [...document.querySelectorAll('input')].map(i => ({ id: i.id, name: i.name, type: i.type })),
}));
console.log(JSON.stringify(info, null, 1));
await context.close();
