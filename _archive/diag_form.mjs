import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const cookies = JSON.parse(readFileSync('session.json', 'utf-8'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ proxy: { server: 'socks5://127.0.0.1:1081' } });
await context.addCookies(cookies);
const page = await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 8; i++) {
  const title = await page.title();
  if (!title.includes('Just a moment')) break;
  console.log('challenge wait', i + 1);
  await page.waitForTimeout(5000);
}
console.log('URL:', page.url());
const html = await page.content();
const m = html.match(/<form[\s\S]*?<\/form>/i);
console.log('FORM:', m ? m[0].slice(0, 2000) : 'NO FORM FOUND');
console.log('inputs:', [...html.matchAll(/<input[^>]*>/g)].map(x => x[0]).join('\n'));
await browser.close();
