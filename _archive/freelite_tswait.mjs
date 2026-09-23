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

let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
if (!ts) { console.log('no turnstile frame'); await context.close(); process.exit(0); }
console.log('turnstile frame:', ts.url().slice(0, 90));

for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const info = await ts.evaluate(() => {
    const check = document.querySelector('input[type=checkbox], [id*=checkbox], [class*=checkbox]');
    const labels = [...document.querySelectorAll('label, span, div')]
      .filter(e => (e.textContent || '').trim() && (e.textContent || '').trim().length < 60 && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)
      .map(e => ({ tag: e.tagName, cls: (e.className||'').slice(0,40), text: (e.textContent||'').trim().slice(0, 50) }))
      .slice(0, 10);
    return {
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 120),
      checkboxes: document.querySelectorAll('input[type=checkbox]').length,
      visibleEls: [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().width > 5 && e.getBoundingClientRect().height > 5 && e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE' && e.tagName !== 'LINK').slice(0, 12).map(e => ({ tag: e.tagName, cls: (e.className||'').slice(0, 40), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })),
      labels,
    };
  }).catch(e => ({ err: e.message.slice(0, 100) }));
  const token = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  console.log(`[poll ${i}] title="${info.title}" token=${token} chk=${info.checkboxes} visEls=${JSON.stringify((info.visibleEls||[]).slice(0,4))}`);
  if (token > 20) { console.log('TOKEN GOT!'); break; }
  if (/checkbox|I'm human|verify|prove/i.test((info.bodyText||'') + ' ' + info.title) && info.checkboxes > 0) { console.log('CHECKBOX VISIBLE:', info.bodyText); break; }
}
console.log('final token len:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
await context.close();