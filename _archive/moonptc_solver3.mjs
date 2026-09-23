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
await page.evaluate(() => { document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove()); });
await page.waitForTimeout(1000);

// Get challenge
const challenge = await page.evaluate(async () => {
  const resp = await fetch('/api/faucet/rotation-captcha/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include', body: JSON.stringify({}),
  });
  return await resp.json();
});
console.log('challenge:', JSON.stringify(challenge).slice(0, 300));

// Solve using boundary-focused scoring with gradient matching
const solution = await page.evaluate(async (ch) => {
  const crop = ch.challenge.crop;
  const loadImg = (src) => new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img); img.onerror = reject; img.src = src;
  });
  
  const [baseImg, fragImg] = await Promise.all([
    loadImg('/captcha/moon-base.webp'),
    loadImg(ch.challenge.image),
  ]);
  
  const size = 400;
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = size; baseCanvas.height = size;
  const baseCtx = baseCanvas.getContext('2d');
  baseCtx.drawImage(baseImg, 0, 0, size, size);
  const baseData = baseCtx.getImageData(0, 0, size, size).data;
  
  const fragCanvas = document.createElement('canvas');
  fragCanvas.width = size; fragCanvas.height = size;
  const fragCtx = fragCanvas.getContext('2d');
  fragCtx.drawImage(fragImg, 0, 0, size, size);
  const fragData = fragCtx.getImageData(0, 0, size, size).data;
  
  const cx = crop.x * size;
  const cy = crop.y * size;
  const radius = crop.radius * size;
  
  // Helper to get pixel at position
  const getPixel = (data, x, y) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return null;
    const idx = (Math.round(y) * size + Math.round(x)) * 4;
    return [data[idx], data[idx+1], data[idx+2]];
  };
  
  // Strategy: For each angle, measure boundary discontinuity
  // Sample pairs of points: one just inside, one just outside the circle
  // At the same angle around the circumference
  // The correct angle minimizes the color difference across the boundary
  
  const scores = [];
  
  for (let angle = 0; angle < 360; angle++) {
    const rad = (-angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    
    let totalDiff = 0;
    let count = 0;
    
    // Sample at many angles around the circumference
    for (let a = 0; a < 360; a += 1) {
      const aRad = (a * Math.PI) / 180;
      
      // Sample 3 pairs at different radii near the boundary
      for (const [innerOffset, outerOffset] of [[-4, 4], [-2, 2], [-6, 6]]) {
        const innerR = radius + innerOffset;
        const outerR = radius + outerOffset;
        
        // Inner point (in fragment, rotated)
        const ix = cx + innerR * Math.cos(aRad);
        const iy = cy + innerR * Math.sin(aRad);
        const dx = ix - cx;
        const dy = iy - cy;
        const srcX = cx + dx * cos - dy * sin;
        const srcY = cy + dx * sin + dy * cos;
        
        // Outer point (in base, no rotation)
        const ox = cx + outerR * Math.cos(aRad);
        const oy = cy + outerR * Math.sin(aRad);
        
        const innerPx = getPixel(fragData, srcX, srcY);
        const outerPx = getPixel(baseData, ox, oy);
        
        if (innerPx && outerPx) {
          const diff = Math.abs(innerPx[0] - outerPx[0]) +
                       Math.abs(innerPx[1] - outerPx[1]) +
                       Math.abs(innerPx[2] - outerPx[2]);
          totalDiff += diff;
          count++;
        }
      }
    }
    
    scores.push({ angle, score: count > 0 ? totalDiff / count : Infinity });
  }
  
  scores.sort((a, b) => a.score - b.score);
  return { best: scores.slice(0, 20) };
}, challenge);

console.log('top 20 angles:', solution.best.map(s => `${s.angle}:${s.score.toFixed(1)}`).join(', '));

// Try the best angle
const bestAngle = solution.best[0].angle;
console.log('\ntrying best angle:', bestAngle);

const verifyResult = await page.evaluate(async (data) => {
  const resp = await fetch('/api/faucet/rotation-captcha/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ session_id: data.sid, angle: data.angle }),
  });
  return await resp.json();
}, { sid: challenge.session_id, angle: bestAngle });

console.log('verify:', JSON.stringify(verifyResult));

if (verifyResult.ok && verifyResult.token) {
  console.log('VERIFIED!');
  const claimResult = await page.evaluate(async (token) => {
    const resp = await fetch('/api/faucet/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ captcha_token: token }),
    });
    return await resp.json();
  }, verifyResult.token);
  console.log('claim:', JSON.stringify(claimResult));
  if (claimResult.ok) console.log('SUCCESS!', claimResult.finalReward, claimResult.roll);
} else {
  // Try next best
  for (const cand of solution.best.slice(1, 5)) {
    console.log(`trying angle ${cand.angle}...`);
    const r = await page.evaluate(async (data) => {
      const resp = await fetch('/api/faucet/rotation-captcha/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ session_id: data.sid, angle: data.angle }),
      });
      return await resp.json();
    }, { sid: challenge.session_id, angle: cand.angle });
    console.log('result:', JSON.stringify(r));
    if (r.ok && r.token) {
      const claimResult = await page.evaluate(async (token) => {
        const resp = await fetch('/api/faucet/claim', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ captcha_token: token }),
        });
        return await resp.json();
      }, r.token);
      console.log('claim:', JSON.stringify(claimResult));
      if (claimResult.ok) console.log('SUCCESS!', claimResult.finalReward, claimResult.roll);
      break;
    }
    if (r.error === 'locked') break;
  }
}

await context.close();