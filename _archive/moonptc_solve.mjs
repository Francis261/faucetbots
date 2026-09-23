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

// Get the full image data (without rotation) and the cutout data
// Then find the angle where the cutout best matches the background
console.log('=== solving rotation puzzle ===');

const solution = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  const puzzleCanvas = canvases[1]; // 384x384 puzzle canvas
  if (!puzzleCanvas) return { error: 'no puzzle canvas' };
  
  const ctx = puzzleCanvas.getContext('2d');
  const w = puzzleCanvas.width;
  const h = puzzleCanvas.height;
  
  // First, save the current state (angle 0)
  const angle0Data = ctx.getImageData(0, 0, w, h).data;
  
  // Find yellow circle bounds
  let yellowPixels = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = angle0Data[idx], g = angle0Data[idx+1], b = angle0Data[idx+2];
      if (g > 180 && r > 150 && b < 100 && (g - b) > 100) {
        yellowPixels.push({ x, y });
      }
    }
  }
  
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of yellowPixels) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const radius = Math.max(maxX - minX, maxY - minY) / 2;
  
  // For each candidate angle, use the React app's rotation mechanism
  // and measure how well the cutout matches the surrounding image
  // 
  // Better approach: The cutout is a circular region that's been rotated.
  // The background image outside the circle is fixed.
  // Inside the circle, the image is rotated by `angle` degrees.
  // We need to find `angle` such that the cutout aligns with the background.
  //
  // Strategy: Compare edge patterns at the circle boundary.
  // For each angle, sample pixels just inside and just outside the circle
  // at various points around the circumference.
  // The correct angle will have the highest similarity (lowest difference).
  
  // First, let's get the "background" reference - pixels just outside the circle
  const refPixels = [];
  for (let a = 0; a < 360; a += 3) {
    const rad = (a * Math.PI) / 180;
    const outerR = radius + 5;
    const sx = Math.round(cx + outerR * Math.cos(rad));
    const sy = Math.round(cy + outerR * Math.sin(rad));
    if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
      const idx = (sy * w + sx) * 4;
      refPixels.push({ angle: a, r: angle0Data[idx], g: angle0Data[idx+1], b: angle0Data[idx+2] });
    }
  }
  
  // Now test each angle by rotating the inner pixels and comparing with reference
  const innerRadius = radius - 5;
  const scores = [];
  
  for (let testAngle = 0; testAngle < 360; testAngle += 1) {
    let totalDiff = 0;
    let count = 0;
    
    for (const ref of refPixels) {
      const rad = (ref.angle * Math.PI) / 180;
      const sx = Math.round(cx + innerRadius * Math.cos(rad));
      const sy = Math.round(cy + innerRadius * Math.sin(rad));
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
        const idx = (sy * w + sx) * 4;
        const diff = Math.abs(angle0Data[idx] - ref.r) +
                     Math.abs(angle0Data[idx+1] - ref.g) +
                     Math.abs(angle0Data[idx+2] - ref.b);
        totalDiff += diff;
        count++;
      }
    }
    
    scores.push({ angle: testAngle, score: count > 0 ? totalDiff / count : Infinity });
  }
  
  // Sort by score (lowest = best match)
  scores.sort((a, b) => a.score - b.score);
  
  return {
    circleCenter: { x: cx, y: cy },
    circleRadius: radius,
    bestAngles: scores.slice(0, 10),
    worstAngles: scores.slice(-5),
  };
});

console.log(JSON.stringify(solution, null, 2));

if (solution.bestAngles) {
  const bestAngle = solution.bestAngles[0].angle;
  console.log('\nBest angle:', bestAngle);
  
  // Set the slider to the best angle
  const slider = page.locator('input[type=range]').first();
  await slider.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, bestAngle);
  
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'moonptc_solved.png', fullPage: false });
  console.log('set slider to', bestAngle, 'and saved screenshot');
}

await context.close();