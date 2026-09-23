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
await page.waitForTimeout(3000);
await page.fill('input[name="faucet_email"]', EMAIL);

// Wait for Turnstile frame
let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
if (!ts) { console.log('no turnstile frame'); await context.close(); process.exit(1); }

console.log('turnstile frame:', ts.url().slice(0, 100));

// Wait for frame to load
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  const htmlLen = await ts.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
  const title = await ts.evaluate(() => document.title || '').catch(() => '');
  console.log(`[${i}] htmlLen=${htmlLen} title="${title}"`);
  if (htmlLen > 100) break;
}

// The Turnstile widget renders its checkbox inside this frame
// Let's try clicking the checkbox by its known position
// In a standard Turnstile widget (301x66), the checkbox is at ~(25, 33)

// Method 1: Use frame-level click on the body
try {
  await ts.locator('body').click({ position: { x: 25, y: 33 }, timeout: 5000 });
  console.log('clicked body at (25,33)');
  await page.waitForTimeout(5000);
  console.log('token after body click:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
} catch(e) {
  console.log('body click failed:', e.message.slice(0, 80));
}

// Method 2: Try to find and click the checkbox element
try {
  const chk = ts.locator('[role="checkbox"], input[type=checkbox], .cb-i');
  const cnt = await chk.count();
  console.log('checkbox count:', cnt);
  if (cnt > 0) {
    await chk.first().click({ timeout: 5000 });
    console.log('clicked checkbox');
    await page.waitForTimeout(5000);
    console.log('token after checkbox click:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
  }
} catch(e) {
  console.log('checkbox click failed:', e.message.slice(0, 80));
}

// Method 3: Use frame element handle
try {
  const frameEl = await page.evaluate(() => {
    const iframes = document.querySelectorAll('iframe');
    for (const f of iframes) {
      if ((f.src || '').includes('turnstile')) return { x: f.getBoundingClientRect().x, y: f.getBoundingClientRect().y, w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height };
    }
    return null;
  });
  console.log('iframe element:', JSON.stringify(frameEl));
  
  if (frameEl) {
    // Click at checkbox position inside the iframe element
    const cx = frameEl.x + 25;
    const cy = frameEl.y + frameEl.h / 2;
    console.log(`clicking iframe element at (${cx}, ${cy})`);
    await page.mouse.move(cx, cy); await page.waitForTimeout(300);
    await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
    await page.waitForTimeout(5000);
    console.log('token after iframe click:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
  }
} catch(e) {
  console.log('iframe click failed:', e.message.slice(0, 80));
}

// Method 4: Try clicking at the captcha-wrap center (the Turnstile widget area)
const wrap = page.locator('.captcha-wrap');
const wrapBox = await wrap.boundingBox().catch(() => null);
if (wrapBox) {
  const cx = wrapBox.x + 25;
  const cy = wrapBox.y + wrapBox.height / 2;
  console.log(`clicking captcha-wrap at (${cx}, ${cy})`);
  await page.mouse.move(cx, cy); await page.waitForTimeout(300);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
  await page.waitForTimeout(5000);
  console.log('token after wrap click:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
}

// Wait and poll token
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(2000);
  const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  if (i % 5 === 0) console.log(`wait[${i}] token=${tok}`);
  if (tok > 20) { console.log('GOT TOKEN!'); break; }
}

await context.close();