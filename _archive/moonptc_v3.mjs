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

// Remove cc overlay on every page load
await page.addInitScript(() => {
  const observer = new MutationObserver(() => {
    document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove());
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
});

await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="email"]', EMAIL);
await page.click('button:has-text("Start Earning")', { timeout: 10000 });
await page.waitForTimeout(5000);
console.log('logged in');

await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(5000);

// Force remove overlay
await page.evaluate(() => {
  document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove());
});
await page.waitForTimeout(1000);

// Check for Turnstile
console.log('\n=== turnstile check ===');
const info = await page.evaluate(() => {
  const hasTurnstile = typeof window.turnstile !== 'undefined';
  const siteKey = window.__TURNSTILE_SITEKEY__ || '';
  const cfIframes = [...document.querySelectorAll('iframe')].filter(f => f.src.includes('challenges.cloudflare.com'));
  return { hasTurnstile, siteKey, cfIframes: cfIframes.map(f => ({ src: f.src.slice(0, 150), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height })) };
});
console.log(JSON.stringify(info, null, 2));

// Click the "I'm not a robot" button with force
console.log('\n=== clicking robot button ===');
const robotBtn = page.locator('button:has-text("I\'m not a robot")');
if (await robotBtn.isVisible()) {
  await robotBtn.click({ force: true, timeout: 5000 });
  console.log('clicked');
  await page.waitForTimeout(8000);
  
  // Check for Turnstile iframe
  const afterClick = await page.evaluate(() => {
    const cfIframes = [...document.querySelectorAll('iframe')].filter(f => f.src.includes('challenges.cloudflare.com'));
    const allIframes = [...document.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 150), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }));
    const turnstile = typeof window.turnstile !== 'undefined';
    return { cfIframes: cfIframes.map(f => f.src.slice(0, 150)), allIframes, turnstile };
  });
  console.log('after click:', JSON.stringify(afterClick, null, 2));
}

await page.screenshot({ path: 'moonptc_v3.png', fullPage: false });
console.log('screenshot saved');
await context.close();