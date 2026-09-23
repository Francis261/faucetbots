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

// Get challenge and debug
const challenge = await page.evaluate(async () => {
  const resp = await fetch('/api/faucet/rotation-captcha/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include', body: JSON.stringify({}),
  });
  const text = await resp.text();
  return { status: resp.status, text };
});
console.log('challenge response:', challenge.status, challenge.text.slice(0, 500));

if (challenge.status === 200) {
  const data = JSON.parse(challenge.text);
  if (data.session_id) {
    // Try a few angles
    for (const angle of [0, 90, 180, 270, 45, 135, 225, 315]) {
      const r = await page.evaluate(async (d) => {
        const resp = await fetch('/api/faucet/rotation-captcha/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ session_id: d.sid, angle: d.angle }),
        });
        return { status: resp.status, body: await resp.json() };
      }, { sid: data.session_id, angle });
      console.log(`angle ${angle}:`, r.status, JSON.stringify(r.body).slice(0, 100));
      if (r.body.ok) {
        console.log('VERIFIED!');
        break;
      }
      if (r.body.error === 'locked') {
        console.log('locked, waiting...');
        await page.waitForTimeout(5000);
      }
    }
  }
}

await context.close();