import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

// Remove overlay
await page.evaluate(() => {
  document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove());
});
await page.waitForTimeout(1000);

// Click "I'm not a robot" via JS
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('robot'));
  if (btn) btn.click();
});
await page.waitForTimeout(8000);

// Check how the rotation works in the React app
console.log('=== checking rotation mechanism ===');
const mechanism = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  const puzzleCanvas = canvases[1];
  if (!puzzleCanvas) return { error: 'no canvas' };
  
  // Check if there's a CSS transform on the canvas or its parent
  const style = window.getComputedStyle(puzzleCanvas);
  const parentStyle = window.getComputedStyle(puzzleCanvas.parentElement);
  const grandparentStyle = window.getComputedStyle(puzzleCanvas.parentElement?.parentElement);
  
  // Check for any element with rotation transform
  const rotatedEls = [...document.querySelectorAll('*')].filter(e => {
    const s = window.getComputedStyle(e);
    return s.transform && s.transform !== 'none';
  }).map(e => ({
    tag: e.tagName, cls: (e.className || '').toString().slice(0, 50),
    transform: window.getComputedStyle(e).transform.slice(0, 100),
    html: e.outerHTML.slice(0, 200),
  }));
  
  // Check the slider's React state
  const slider = document.querySelector('input[type=range]');
  let reactState = null;
  if (slider) {
    // Try to find React fiber
    const key = Object.keys(slider).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (key) {
      const fiber = slider[key];
      // Walk up to find the state
      let node = fiber;
      for (let i = 0; i < 10 && node; i++) {
        if (node.memoizedState) {
          reactState = JSON.stringify(node.memoizedState).slice(0, 200);
          break;
        }
        node = node.return;
      }
    }
  }
  
  return {
    canvasTransform: style.transform,
    parentTransform: parentStyle.transform,
    grandparentTransform: grandparentStyle.transform,
    rotatedEls: rotatedEls.slice(0, 5),
    reactState,
  };
});
console.log(JSON.stringify(mechanism, null, 2));

// Try setting slider and check the canvas transform
const slider = page.locator('input[type=range]').first();

for (const angle of [0, 90, 180, 270]) {
  await slider.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, angle);
  await page.waitForTimeout(500);
  
  const transform = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const c = canvases[1];
    if (!c) return null;
    // Check all ancestors for transforms
    let el = c;
    const transforms = [];
    while (el) {
      const t = window.getComputedStyle(el).transform;
      if (t && t !== 'none') transforms.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,40), transform: t.slice(0,80) });
      el = el.parentElement;
    }
    return transforms;
  });
  console.log(`angle ${angle}: transforms:`, JSON.stringify(transform));
}

await context.close();