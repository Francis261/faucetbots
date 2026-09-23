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

// Try multiple challenges with a brute-force approach
// For each challenge, try ALL 360 angles using the verify endpoint
// The tolerance is 10 degrees, so we can narrow down quickly

async function tryChallenge() {
  const challenge = await page.evaluate(async () => {
    const resp = await fetch('/api/faucet/rotation-captcha/challenge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({}),
    });
    return await resp.json();
  });
  
  if (!challenge.session_id) return null;
  console.log('challenge:', challenge.challenge.id.slice(0, 20), 'crop:', challenge.challenge.crop);
  
  // Binary search approach: test angles in batches
  // First test every 30 degrees
  const coarseScores = [];
  for (let angle = 0; angle < 360; angle += 30) {
    const r = await page.evaluate(async (data) => {
      const resp = await fetch('/api/faucet/rotation-captcha/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ session_id: data.sid, angle: data.angle }),
      });
      return await resp.json();
    }, { sid: challenge.session_id, angle: angle });
    
    if (r.ok && r.token) return { token: r.token, angle };
    if (r.error === 'locked') return null;
    if (r.error === 'wrong') {
      coarseScores.push({ angle, attemptsLeft: r.attempts_left });
      console.log(`  angle ${angle}: wrong (${r.attempts_left} left)`);
    }
    if (r.attempts_left <= 0) return null;
  }
  
  return null;
}

// Try up to 5 challenges
for (let i = 0; i < 5; i++) {
  console.log(`\n=== challenge ${i + 1} ===`);
  const result = await tryChallenge();
  if (result && result.token) {
    console.log('VERIFIED at angle', result.angle);
    const claimResult = await page.evaluate(async (token) => {
      const resp = await fetch('/api/faucet/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ captcha_token: token }),
      });
      return await resp.json();
    }, result.token);
    console.log('claim:', JSON.stringify(claimResult));
    if (claimResult.ok) {
      console.log('SUCCESS!', claimResult.finalReward, claimResult.roll);
      break;
    }
  }
  // Wait before next challenge
  await page.waitForTimeout(3000);
}

await context.close();