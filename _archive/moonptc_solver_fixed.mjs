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

if (!challenge.session_id) { await context.close(); process.exit(1); }

// Solve with FIXED rotation formula
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
  
  const getPixel = (data, x, y) => {
    const rx = Math.round(x), ry = Math.round(y);
    if (rx < 0 || rx >= size || ry < 0 || ry >= size) return null;
    const idx = (ry * size + rx) * 4;
    return [data[idx], data[idx+1], data[idx+2]];
  };
  
  // FIXED: canvas.rotate(T) means fragment pixel at local (lx, ly) appears at
  // canvas (cx + lx*cos(T) - ly*sin(T), cy + lx*sin(T) + ly*cos(T))
  // To find fragment pixel at canvas position (cx+dx, cy+dy):
  //   lx = dx*cos(T) + dy*sin(T)
  //   ly = -dx*sin(T) + dy*cos(T)
  
  const scores = [];
  
  for (let angle = 0; angle < 360; angle++) {
    const T = (angle * Math.PI) / 180;
    const cosT = Math.cos(T);
    const sinT = Math.sin(T);
    
    let totalDiff = 0;
    let count = 0;
    
    // Sample boundary pairs: inner (fragment) vs outer (base)
    for (let a = 0; a < 360; a += 1) {
      const aRad = (a * Math.PI) / 180;
      const cosA = Math.cos(aRad);
      const sinA = Math.sin(aRad);
      
      for (const [innerOff, outerOff] of [[-4, 4], [-2, 2], [-6, 6], [-8, 8]]) {
        // Canvas position of inner point
        const dx = (radius + innerOff) * cosA;
        const dy = (radius + innerOff) * sinA;
        
        // Fragment source (using FIXED formula)
        const lx = dx * cosT + dy * sinT;
        const ly = -dx * sinT + dy * cosT;
        const srcX = cx + lx;
        const srcY = cy + ly;
        
        // Outer reference
        const ox = cx + (radius + outerOff) * cosA;
        const oy = cy + (radius + outerOff) * sinA;
        
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
  return { best: scores.slice(0, 15) };
}, challenge);

console.log('top angles:', solution.best.map(s => `${s.angle}:${s.score.toFixed(1)}`).join(', '));

// Try best angle
const bestAngle = solution.best[0].angle;
console.log('\ntrying angle:', bestAngle);

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
  // Try next candidates
  for (const cand of solution.best.slice(1, 5)) {
    console.log(`trying ${cand.angle}...`);
    const r = await page.evaluate(async (d) => {
      const resp = await fetch('/api/faucet/rotation-captcha/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ session_id: d.sid, angle: d.angle }),
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