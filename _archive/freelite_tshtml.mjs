import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'freelite-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://freelitecoin.online/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.fill('input[name="faucet_email"]', EMAIL);
await page.waitForTimeout(6000);

// wait for turnstile frame
let ts;
for (let i = 0; i < 10 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
if (!ts) { console.log('no turnstile frame'); await context.close(); process.exit(0); }
console.log('turnstile frame url:', ts.url().slice(0, 120));

// dump frame html
const html = await ts.content().catch(e => 'ERR ' + e.message.slice(0, 100));
console.log('frame html length:', html.length);
console.log('--- html snippet ---');
console.log(html.slice(0, 3000));

// look for any interactive elements inside
const els = await ts.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') {
      out.push({ tag: el.tagName, cls: (el.className||'').slice(0,50), id: (el.id||'').slice(0,30), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), role: el.getAttribute('role')||'' });
    }
  }
  return out.slice(0, 40);
}).catch(e => []);
console.log('frame elements:', JSON.stringify(els, null, 1));

await context.close();