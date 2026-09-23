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

// Solve using dense interior sampling
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
  
  // Pre-compute all sample points inside the circle
  const samplePoints = [];
  for (let dy = -radius; dy <= radius; dy += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius - 2) {
        samplePoints.push({ dx, dy });
      }
    }
  }
  
  // For each angle, rotate all sample points and compare with base
  const scores = [];
  for (let angle = 0; angle < 360; angle++) {
    const rad = (-angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    
    let totalDiff = 0;
    let count = 0;
    
    for (const pt of samplePoints) {
      // Source position in fragment (unrotated)
      const srcX = Math.round(cx + pt.dx * cos - pt.dy * sin);
      const srcY = Math.round(cy + pt.dx * sin + pt.dy * cos);
      
      // Target position in base
      const tgtX = Math.round(cx + pt.dx);
      const tgtY = Math.round(cy + pt.dy);
      
      if (srcX >= 0 && srcX < size && srcY >= 0 && srcY < size &&
          tgtX >= 0 && tgtX < size && tgtY >= 0 && tgtY < size) {
        const srcIdx = (srcY * size + srcX) * 4;
        const tgtIdx = (tgtY * size + tgtX) * 4;
        
        const diff = Math.abs(baseData[tgtIdx] - fragData[srcIdx]) +
                     Math.abs(baseData[tgtIdx+1] - fragData[srcIdx+1]) +
                     Math.abs(baseData[tgtIdx+2] - fragData[srcIdx+2]);
        totalDiff += diff;
        count++;
      }
    }
    
    scores.push({ angle, score: count > 0 ? totalDiff / count : Infinity });
  }
  
  scores.sort((a, b) => a.score - b.score);
  return { best: scores.slice(0, 15) };
}, challenge);

console.log('best angles:', JSON.stringify(solution.best.slice(0, 10)));

// Try each of the top 3 angles
for (const candidate of solution.best.slice(0, 3)) {
  console.log(`\n=== trying angle ${candidate.angle} (score: ${candidate.score.toFixed(2)}) ===`);
  const verifyResult = await page.evaluate(async (data) => {
    const resp = await fetch('/api/faucet/rotation-captcha/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ session_id: data.sid, angle: data.angle }),
    });
    return await resp.json();
  }, { sid: challenge.session_id, angle: candidate.angle });
  
  console.log('verify:', JSON.stringify(verifyResult));
  
  if (verifyResult.ok && verifyResult.token) {
    console.log('VERIFIED! Token:', verifyResult.token.slice(0, 30));
    
    // Claim
    const claimResult = await page.evaluate(async (token) => {
      const resp = await fetch('/api/faucet/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ captcha_token: token }),
      });
      return await resp.json();
    }, verifyResult.token);
    
    console.log('claim:', JSON.stringify(claimResult));
    if (claimResult.ok) {
      console.log('SUCCESS! Reward:', claimResult.finalReward, 'Roll:', claimResult.roll);
    }
    break;
  }
  
  if (verifyResult.error === 'wrong' && verifyResult.attempts_left === 0) {
    console.log('no attempts left, need new challenge');
    break;
  }
}

await context.close();