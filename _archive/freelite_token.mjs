import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic986532@gmail.com';
const REFERRAL = 'https://freelitecoin.online/index.php?ref=24084';
const TEMP = mkdtempSync(join(tmpdir(), 'freelite-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto(REFERRAL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[name="faucet_email"]', EMAIL);

// solve turnstile
let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
console.log('ts:', !!ts);
if (ts) {
  for (let i = 0; i < 10; i++) {
    const htmlLen = await ts.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
    if (htmlLen > 0) break;
    await page.waitForTimeout(1000);
  }
  
  // monitor token changes
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
    if (i === 5) {
      console.log('clicking turnstile checkbox...');
      await ts.locator('body').click({ position: { x: 25, y: 33 }, timeout: 5000 }).catch(e => console.log('click err:', e.message.slice(0, 60)));
    }
    if (i % 3 === 0 || tok > 20) console.log(`[${i}] token=${tok}`);
    if (tok > 20) break;
  }
  
  console.log('final token:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
}

await context.close();