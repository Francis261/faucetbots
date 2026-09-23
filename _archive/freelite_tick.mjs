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
await page.waitForTimeout(2000);
await page.fill('input[name="faucet_email"]', EMAIL);
await page.waitForTimeout(4000);

const inputToken = () => page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '');
console.log('token before click:', (await inputToken()).length);

// find the turnstile iframe element and its page box
async function tsBox() {
  return await page.evaluate(() => {
    for (const f of document.querySelectorAll('iframe')) {
      if ((f.src || '').includes('turnstile')) {
        const r = f.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, src: f.src.slice(0, 80) };
      }
    }
    return null;
  });
}
let box = await tsBox();
console.log('turnstile iframe box:', JSON.stringify(box));
if (!box) {
  // maybe shadow dom; scan all elements
  box = await page.evaluate(() => {
    const walk = node => {
      const sr = node.shadowRoot;
      if (sr) { for (const c of sr.querySelectorAll('iframe')) { const r = c.getBoundingClientRect(); if (r.width > 0) return { x: r.x, y: r.y, w: r.width, h: r.height, src: c.src.slice(0, 80) }; } }
      for (const c of node.children) { const res = walk(c); if (res) return res; }
      return null;
    };
    return walk(document.body);
  });
  console.log('turnstile iframe box (shadow):', JSON.stringify(box));
}

// click around the checkbox area (top-left of the widget frame)
if (box) {
  const clicks = [
    { dx: 20, dy: box.h / 2, label: 'left-center' },
    { dx: box.w / 2, dy: box.h / 2, label: 'center' },
    { dx: 15, dy: 15, label: 'top-left' },
  ];
  for (const c of clicks) {
    const before = (await inputToken()).length;
    if (before > 20) break;
    const cx = box.x + c.dx;
    const cy = box.y + c.dy;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(2500);
    const after = (await inputToken()).length;
    console.log(`click ${c.label} at ${cx.toFixed(0)},${cy.toFixed(0)} -> token ${before} -> ${after}`);
  }
}

await page.waitForTimeout(2000);
console.log('final token len:', (await inputToken()).length);

await context.close();