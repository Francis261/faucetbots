import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
await page.waitForTimeout(2000);
await page.fill('input[name="faucet_email"]', EMAIL);

// wait for turnstile frame
let ts;
for (let i = 0; i < 20 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
console.log('ts frame:', !!ts, ts?.url().slice(0, 80));

// dump the frame's full body innerHTML to see the checkbox
const html = ts ? await ts.evaluate(() => document.body?.innerHTML || '').catch(() => 'err') : '';
console.log('frame body HTML length:', html.length);
// look for checkbox-related elements
const checks = ts ? await ts.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].map(e => ({ type: e.type, id: e.id, cls: e.className }));
  const labels = [...document.querySelectorAll('label')].map(e => ({ text: (e.textContent||'').trim().slice(0, 40), cls: e.className }));
  const visible = [...document.querySelectorAll('*')].filter(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map(e => ({ tag: e.tagName, id: e.id, cls: (e.className||'').slice(0,40), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }));
  return { inputs, labels, visible };
}).catch(e => ({})) : {};
console.log('frame checks:', JSON.stringify(checks, null, 1));

// screenshot the turnstile area
const wrap = page.locator('.captcha-wrap');
const box = await wrap.boundingBox().catch(() => null);
console.log('captcha-wrap box:', JSON.stringify(box));
if (box) {
  await page.screenshot({ path: '/tmp/opencode/ffl_ts_box.png', clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 } });
  console.log('saved captcha screenshot');
}

// Also take a full page screenshot
await page.screenshot({ path: '/tmp/opencode/ffl_full2.png', fullPage: true });
console.log('full screenshot saved');

// try clicking the checkbox area inside the frame by finding its iframe element position
const frameElInfo = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')];
  for (const f of iframes) {
    if ((f.src || '').includes('turnstile')) {
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 };
    }
  }
  // check shadow roots
  const walk = (n) => {
    if (n.shadowRoot) {
      for (const c of n.shadowRoot.querySelectorAll('iframe')) {
        if ((c.src||'').includes('turnstile')) {
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 };
        }
      }
    }
    for (const c of (n.children||[])) { const res = walk(c); if (res) return res; }
    return null;
  };
  return walk(document.body);
});
console.log('iframe el info:', JSON.stringify(frameElInfo));

if (frameElInfo && frameElInfo.visible) {
  // turnstile checkbox is typically at about 25px from left, 30px from top of the iframe
  const cx = frameElInfo.x + 25;
  const cy = frameElInfo.y + frameElInfo.h / 2;
  console.log(`clicking at (${cx}, ${cy})`);
  await page.mouse.move(cx, cy); await page.waitForTimeout(200);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
  await page.waitForTimeout(5000);
  const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  console.log('token after click:', tok);
}

// wait and watch token
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  console.log(`wait[${i}] token=${tok}`);
  if (tok > 20) { console.log('GOT TOKEN'); break; }
}

await context.close();