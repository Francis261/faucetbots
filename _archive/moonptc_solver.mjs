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

// Step 1: Get challenge from API
console.log('=== step 1: get challenge ===');
const challenge = await page.evaluate(async () => {
  const resp = await fetch('/api/faucet/rotation-captcha/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  });
  return await resp.json();
});
console.log('challenge:', JSON.stringify(challenge).slice(0, 500));

if (!challenge.session_id) {
  console.log('no session_id, exiting');
  await context.close();
  process.exit(1);
}

// Step 2: Solve the puzzle using canvas analysis
console.log('\n=== step 2: solve puzzle ===');
const solution = await page.evaluate(async (ch) => {
  const crop = ch.challenge.crop;
  const baseImgSrc = '/captcha/moon-base.webp';
  const fragImgSrc = ch.challenge.image;
  
  // Load both images
  const loadImg = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
  
  const [baseImg, fragImg] = await Promise.all([loadImg(baseImgSrc), loadImg(fragImgSrc)]);
  
  // Create canvases
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
  
  // Circle parameters (as fractions of canvas size)
  const cx = crop.x * size;
  const cy = crop.y * size;
  const radius = crop.radius * size;
  
  // For each angle, rotate the fragment and measure edge continuity
  const scores = [];
  
  for (let angle = 0; angle < 360; angle += 1) {
    // Draw rotated fragment
    fragCtx.clearRect(0, 0, size, size);
    fragCtx.drawImage(fragImg, 0, 0, size, size);
    const fragData = fragCtx.getImageData(0, 0, size, size).data;
    
    // For the rotation, we need to sample the fragment at rotated positions
    // The fragment image is the original unrotated piece
    // When rotated by `angle`, pixel at (x,y) in the rotated image
    // comes from position obtained by rotating (x-cx, y-cy) by -angle
    
    const rad = (-angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    
    let totalDiff = 0;
    let count = 0;
    
    // Sample at the circle boundary (inner ring)
    for (let a = 0; a < 360; a += 2) {
      const aRad = (a * Math.PI) / 180;
      
      // Outer reference point (just outside the circle)
      const outerR = radius + 3;
      const ox = Math.round(cx + outerR * Math.cos(aRad));
      const oy = Math.round(cy + outerR * Math.sin(aRad));
      
      // Inner test point (just inside the circle)
      const innerR = radius - 3;
      const ix = cx + innerR * Math.cos(aRad);
      const iy = cy + innerR * Math.sin(aRad);
      
      // Rotate this point by -angle to get source position in fragment
      const dx = ix - cx;
      const dy = iy - cy;
      const srcX = Math.round(cx + dx * cos - dy * sin);
      const srcY = Math.round(cy + dx * sin + dy * cos);
      
      if (srcX >= 0 && srcX < size && srcY >= 0 && srcY < size &&
          ox >= 0 && ox < size && oy >= 0 && oy < size) {
        const outerIdx = (oy * size + ox) * 4;
        const innerIdx = (srcY * size + srcX) * 4;
        
        const diff = Math.abs(baseData[outerIdx] - fragData[innerIdx]) +
                     Math.abs(baseData[outerIdx+1] - fragData[innerIdx+1]) +
                     Math.abs(baseData[outerIdx+2] - fragData[innerIdx+2]);
        totalDiff += diff;
        count++;
      }
    }
    
    scores.push({ angle, score: count > 0 ? totalDiff / count : Infinity });
  }
  
  scores.sort((a, b) => a.score - b.score);
  return {
    best: scores.slice(0, 10),
    worst: scores.slice(-5),
    crop,
  };
}, challenge);

console.log('best angles:', JSON.stringify(solution.best));

const bestAngle = solution.best[0].angle;
console.log('best angle:', bestAngle);

// Step 3: Verify the angle
console.log('\n=== step 3: verify ===');
const verifyResult = await page.evaluate(async (data) => {
  const resp = await fetch('/api/faucet/rotation-captcha/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ session_id: data.sessionId, angle: data.angle }),
  });
  return await resp.json();
}, { sessionId: challenge.session_id, angle: bestAngle });

console.log('verify result:', JSON.stringify(verifyResult));

if (verifyResult.ok && verifyResult.token) {
  // Step 4: Claim faucet with the token
  console.log('\n=== step 4: claim faucet ===');
  const claimResult = await page.evaluate(async (token) => {
    const resp = await fetch('/api/faucet/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ captcha_token: token }),
    });
    return await resp.json();
  }, verifyResult.token);
  
  console.log('claim result:', JSON.stringify(claimResult));
  
  if (claimResult.ok) {
    console.log('CLAIMED! Reward:', claimResult.finalReward, 'Roll:', claimResult.roll);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    const balance = await page.evaluate(() => document.body.innerText.match(/(\d+)\s*$/m)?.[1] || '');
    console.log('balance after claim:', balance);
  }
}

await page.screenshot({ path: 'moonptc_solved.png', fullPage: false });
await context.close();