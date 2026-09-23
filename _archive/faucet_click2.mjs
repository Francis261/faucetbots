import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://claimfreecoins.io/tether-faucet/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

const initialState = await page.evaluate(() => ({
  hasAddress: !!document.querySelector('input#address'),
  hasLoginBtn: !!document.querySelector('button[data-target="#captchaModal"], input#login'),
  url: location.href,
}));
console.log('page state:', JSON.stringify(initialState));

await page.fill('input#address', EMAIL).catch(e => console.log('fill err:', e.message.slice(0, 60)));
await page.click('button[data-target="#captchaModal"]', { timeout: 10000 }).catch(e => console.log('open modal err:', e.message.slice(0, 60)));
await page.waitForTimeout(2000);
console.log('modal present:', await page.locator('#captchaModal').count());

await page.evaluate(() => {
  const m = document.querySelector('#captchaModal');
  if (m) { m.classList.add('show'); m.style.display = 'block';
    const bd = document.createElement('div'); bd.className = 'modal-backdrop fade show'; document.body.appendChild(bd); }
});

// retry looking for anchor, and dump all frames
let anchor = null;
for (let i = 0; i < 6 && !anchor; i++) {
  await page.waitForTimeout(1000);
  const urls = page.frames().map(f => f.url());
  console.log(`frames[${i}]:`, urls.map(u => u.slice(0, 70)));
  anchor = page.frames().find(f => /api2\/anchor/i.test(f.url()));
}
if (!anchor) { console.log('NO ANCHOR EVER'); await context.close(); process.exit(1); }

// checkbox within anchor with retry
let cbRect = null;
for (let i = 0; i < 10 && !cbRect; i++) {
  cbRect = await anchor.evaluate(() => {
    const box = document.querySelector('#recaptcha-anchor') || document.querySelector('.recaptcha-checkbox');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cls: box.className };
  }).catch(() => null);
  if (!cbRect) await page.waitForTimeout(1000);
}
console.log('checkbox:', JSON.stringify(cbRect));
console.log('anchor body:', (await anchor.evaluate(() => document.body?.innerText || '')).slice(0, 80));

const frameElInfo = await page.evaluate(() => {
  const frames = [...document.querySelectorAll('iframe')];
  for (const f of frames) {
    if ((f.src || '').includes('api2/anchor')) {
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
  }
  return null;
});
console.log('anchor iframe page-rect:', JSON.stringify(frameElInfo));

if (frameElInfo && cbRect) {
  const cx = frameElInfo.x + cbRect.x + cbRect.w / 2;
  const cy = frameElInfo.y + cbRect.y + cbRect.h / 2;
  console.log(`absolute click at ${cx.toFixed(1)}, ${cy.toFixed(1)}`);
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(4000);
  const after = await anchor.evaluate(() => {
    const box = document.querySelector('#recaptcha-anchor') || document.querySelector('.recaptcha-checkbox');
    return { cls: box ? box.className : 'none', body: (document.body?.innerText || '').slice(0, 60) };
  });
  console.log('after click:', JSON.stringify(after));
  const resp = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
  console.log('g-recaptcha-response len:', resp.length);
}
await context.close();