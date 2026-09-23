import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
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

// Get the puzzle image data and analyze it
console.log('=== analyzing puzzle for rotation angle ===');
const analysis = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  const puzzleCanvas = canvases[1]; // The puzzle canvas (384x384)
  if (!puzzleCanvas) return { error: 'no puzzle canvas' };
  
  const ctx = puzzleCanvas.getContext('2d');
  const w = puzzleCanvas.width;
  const h = puzzleCanvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  
  // Find the yellow/green circle center and radius
  // Yellow/green pixels: high G, high R, low B
  let yellowPixels = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      // Yellow/green circle: bright green/yellow
      if (g > 180 && r > 150 && b < 100 && (g - b) > 100) {
        yellowPixels.push({ x, y });
      }
    }
  }
  
  // Find circle center and radius from yellow pixels
  if (yellowPixels.length < 10) return { error: 'not enough yellow pixels', count: yellowPixels.length };
  
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of yellowPixels) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const radius = Math.max(maxX - minX, maxY - minY) / 2;
  
  // Sample the image inside the circle at different angles
  // Look for the dome structure - glass panels have blue/gray colors
  // The cutout is rotated, so we need to find where the glass panel lines match
  
  // Sample pixels at the circle edge at different angles
  const samples = [];
  for (let angle = 0; angle < 360; angle += 5) {
    const rad = (angle * Math.PI) / 180;
    // Sample at multiple radii
    let edgeR = 0, edgeG = 0, edgeB = 0, count = 0;
    for (let r = radius * 0.7; r <= radius * 0.95; r += 2) {
      const sx = Math.round(centerX + r * Math.cos(rad));
      const sy = Math.round(centerY + r * Math.sin(rad));
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
        const idx = (sy * w + sx) * 4;
        edgeR += data[idx]; edgeG += data[idx+1]; edgeB += data[idx+2]; count++;
      }
    }
    if (count > 0) {
      samples.push({
        angle,
        r: Math.round(edgeR / count),
        g: Math.round(edgeG / count),
        b: Math.round(edgeB / count),
      });
    }
  }
  
  // The dome has glass panels - look for the dominant direction of the glass lines
  // Glass panels are typically blue-ish with white/gray frames
  // Find angles where we see the glass panel edges (high contrast transitions)
  const contrasts = [];
  for (let i = 0; i < samples.length; i++) {
    const next = samples[(i + 1) % samples.length];
    const diff = Math.abs(samples[i].r - next.r) + Math.abs(samples[i].g - next.g) + Math.abs(samples[i].b - next.b);
    contrasts.push({ angle: samples[i].angle, contrast: diff });
  }
  
  // Sort by contrast to find the dominant edges
  contrasts.sort((a, b) => b.contrast - a.contrast);
  
  return {
    yellowPixelCount: yellowPixels.length,
    circleCenter: { x: centerX, y: centerY },
    circleRadius: radius,
    topContrasts: contrasts.slice(0, 10),
    sampleCount: samples.length,
  };
});
console.log(JSON.stringify(analysis, null, 2));

// Now try different rotation angles and see which one looks correct
// The approach: set slider to different angles, take screenshots, and compare
console.log('\n=== trying rotation angles ===');

// Get slider element
const slider = page.locator('input[type=range]').first();

// Try a few angles to understand the puzzle
for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) {
  await slider.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, angle);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `moonptc_angle_${angle}.png`, fullPage: false });
  console.log(`saved angle ${angle}`);
}

await context.close();