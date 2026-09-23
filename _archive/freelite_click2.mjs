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
await page.waitForTimeout(2500);
await page.fill('input[name="faucet_email"]', EMAIL);

// Wait for Turnstile frame
let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
if (!ts) { console.log('no turnstile frame'); await context.close(); process.exit(1); }

// The checkbox is inside the frame. Let me try clicking it via frame coordinates.
// Turnstile checkbox is typically at ~25,33 inside the 301x66 frame.
// The frame is rendered at a fixed position on the page. Let me find that.
// Use frame.locator to find any clickable element
const frameClickables = await ts.evaluate(() => {
  const all = [...document.querySelectorAll('*')];
  return all.filter(e => e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE').map(e => {
    const r = e.getBoundingClientRect();
    return { tag: e.tagName, id: e.id, cls: (e.className||'').slice(0, 50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), clickable: e.getAttribute('role') === 'button' || e.tagName === 'INPUT' || e.tagName === 'LABEL' };
  }).filter(e => e.w > 0);
});
console.log('frame elements:', JSON.stringify(frameClickables, null, 1));

// Try using the frame locator approach - find the turnstile element
const turnstileEl = page.locator('.cf-turnstile');
const tBox = await turnstileEl.boundingBox().catch(() => null);
console.log('.cf-turnstile box:', JSON.stringify(tBox));

// The Turnstile iframe is rendered OUTSIDE the DOM by CF's script. 
// It sits at the exact position of the .cf-turnstile div.
// The checkbox is typically at ~(25, 33) from the top-left of the widget.
if (tBox) {
  // Click at the checkbox position (left side, middle height)
  const cx = tBox.x + 25;
  const cy = tBox.y + tBox.height / 2;
  console.log(`clicking checkbox at (${cx}, ${cy})`);
  
  // Move to position, then click with a slight delay to simulate human
  await page.mouse.move(cx - 50, cy); await page.waitForTimeout(300);
  await page.mouse.move(cx, cy); await page.waitForTimeout(200);
  await page.mouse.down(); await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(3000);
  
  const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  console.log('token after checkbox click:', tok);
}

// Also try using page.frameLocator to access the iframe
try {
  const fl = page.frameLocator('iframe[src*="turnstile"]');
  const checkbox = fl.locator('#cf-chl-widget-*_response, input[type=checkbox], [role=checkbox]');
  const cnt = await checkbox.count().catch(() => 0);
  console.log('frame locator checkbox count:', cnt);
} catch(e) {
  console.log('frame locator err:', e.message.slice(0, 80));
}

// Let me also check all frames in the page for turnstile content
console.log('all frames:', page.frames().map(f => f.url().slice(0, 70)));

// Try the frame itself
const innerContent = await ts.evaluate(() => {
  return { body: document.body?.outerHTML?.slice(0, 500) || 'empty', scripts: [...document.querySelectorAll('script')].map(s => s.src?.slice(0, 80)).filter(Boolean) };
}).catch(e => ({}));
console.log('frame inner:', JSON.stringify(innerContent));

// wait for token
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1500);
  const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  if (i % 5 === 0) console.log(`wait[${i}] token=${tok}`);
  if (tok > 20) { console.log('GOT TOKEN!'); break; }
}

await context.close();