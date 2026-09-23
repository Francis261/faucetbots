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

// Analyze the rotation puzzle
console.log('=== analyzing rotation puzzle ===');
const puzzleData = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  const sliders = [...document.querySelectorAll('input[type=range]')];
  
  // Get canvas data
  const canvasInfo = canvases.map((c, i) => {
    const r = c.getBoundingClientRect();
    const ctx = c.getContext('2d');
    const data = ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
    // Sample some pixels to understand the image
    const samples = [];
    if (data) {
      for (let y = 0; y < c.height; y += Math.floor(c.height / 10)) {
        for (let x = 0; x < c.width; x += Math.floor(c.width / 10)) {
          const idx = (y * c.width + x) * 4;
          samples.push({ x, y, r: data[idx], g: data[idx+1], b: data[idx+2], a: data[idx+3] });
        }
      }
    }
    return {
      index: i, width: c.width, height: c.height,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      style: c.style.cssText.slice(0, 200),
      cls: (c.className || '').slice(0, 50),
      parentCls: (c.parentElement?.className || '').slice(0, 80),
      sampleCount: samples.length,
      // Check if canvas has yellow circle (cutout)
      hasYellow: samples.some(s => s.r > 200 && s.g > 200 && s.b < 100),
    };
  });
  
  // Get slider info
  const sliderInfo = sliders.map((s, i) => ({
    index: i, min: s.min, max: s.max, value: s.value, step: s.step,
    rect: s.getBoundingClientRect(),
    cls: (s.className || '').slice(0, 80),
  }));
  
  // Get the rotation angle from React state
  const rotationAngle = window.__rotationAngle || null;
  
  return { canvases: canvasInfo, sliders: sliderInfo, rotationAngle };
});
console.log(JSON.stringify(puzzleData, null, 2));

// Save canvas images for analysis
for (let i = 0; i < puzzleData.canvases.length; i++) {
  const dataUrl = await page.evaluate((idx) => {
    const canvases = [...document.querySelectorAll('canvas')];
    const c = canvases[idx];
    return c ? c.toDataURL('image/png') : null;
  }, i);
  if (dataUrl) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    writeFileSync(`moonptc_canvas_${i}.png`, Buffer.from(base64, 'base64'));
    console.log(`saved canvas ${i}`);
  }
}

// Try to find the rotation API endpoint
console.log('\n=== checking rotation API ===');
const apiResult = await page.evaluate(async () => {
  try {
    const resp = await fetch('/api/faucet/rotation-captcha', { credentials: 'include' });
    return await resp.json();
  } catch(e) {
    return { error: e.message };
  }
});
console.log('rotation API:', JSON.stringify(apiResult).slice(0, 500));

// Also check the current slider value
const sliderVal = await page.evaluate(() => {
  const s = document.querySelector('input[type=range]');
  return s ? { value: s.value, min: s.min, max: s.max } : null;
});
console.log('slider:', sliderVal);

await page.screenshot({ path: 'moonptc_puzzle_detail.png', fullPage: false });
await context.close();