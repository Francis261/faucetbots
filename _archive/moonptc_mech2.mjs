import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'moonptc-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="email"]', EMAIL);
await page.click('button:has-text("Start Earning")', { timeout: 10000 });
await page.waitForTimeout(5000);
console.log('logged in');

await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

await page.evaluate(() => {
  document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove());
});
await page.waitForTimeout(1000);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('robot'));
  if (btn) btn.click();
});
await page.waitForTimeout(8000);

const slider = page.locator('input[type=range]').first();

// Check how rotation works by monitoring canvas pixel changes
for (const angle of [0, 90, 180, 270]) {
  await slider.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, angle);
  await page.waitForTimeout(500);
  
  // Check canvas transforms on all ancestors
  const transforms = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const c = canvases[1];
    if (!c) return [];
    const results = [];
    let el = c;
    while (el && el !== document.body) {
      const t = window.getComputedStyle(el).transform;
      if (t && t !== 'none') {
        results.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 50),
          transform: t.slice(0, 100),
        });
      }
      el = el.parentElement;
    }
    return results;
  });
  console.log(`angle ${angle}:`, JSON.stringify(transforms));
  
  // Also check the canvas pixel at a specific point to see if it changes
  const pixel = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const c = canvases[1];
    if (!c) return null;
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(191, 197, 1, 1).data;
    return { r: data[0], g: data[1], b: data[2] };
  });
  console.log(`  center pixel:`, JSON.stringify(pixel));
}

// Now let's look at the React source for the rotation captcha component
// Search for "rotation" in the page scripts
console.log('\n=== searching for rotation logic ===');
const rotationCode = await page.evaluate(() => {
  const scripts = [...document.querySelectorAll('script')];
  for (const s of scripts) {
    if (s.src && s.src.includes('index')) {
      return s.src;
    }
  }
  return null;
});
console.log('main script:', rotationCode);

await context.close();