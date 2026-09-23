import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const SITEKEY = '0x4AAAAAAEFiuCNTLp_xRBDo';
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

// Remove Captcha.com overlay that blocks everything
console.log('=== removing cc overlay ===');
await page.evaluate(() => {
  document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove());
});
await page.waitForTimeout(1000);

// Remove any other blocking overlays
await page.evaluate(() => {
  document.querySelectorAll('[style*="z-index: 2147483647"]').forEach(el => {
    if (el.className && el.className.includes('cc-')) el.remove();
  });
});

// Load Turnstile script
console.log('=== loading turnstile ===');
await page.evaluate((sitekey) => {
  return new Promise((resolve, reject) => {
    if (window.turnstile) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.dataset.moonTurnstile = 'true';
    script.onload = () => {
      window.turnstile.ready(() => resolve());
    };
    script.onerror = () => reject(new Error('Failed to load Turnstile'));
    document.head.appendChild(script);
  });
}, SITEKEY);
console.log('turnstile loaded');

// Find the widget container and render Turnstile
console.log('=== rendering turnstile ===');
const widgetResult = await page.evaluate((sitekey) => {
  // Find the "I'm not a robot" container
  const robotBtn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('robot'));
  if (!robotBtn) return { error: 'no robot button found' };
  
  const container = robotBtn.closest('div');
  if (!container) return { error: 'no container' };
  
  // Create a Turnstile widget div
  const widgetDiv = document.createElement('div');
  widgetDiv.id = 'moon-turnstile-widget';
  widgetDiv.style.cssText = 'margin: 10px auto; text-align: center;';
  container.parentElement.insertBefore(widgetDiv, container);
  
  // Hide the original "I'm not a robot" button
  robotBtn.style.display = 'none';
  
  // Render Turnstile
  try {
    const widgetId = window.turnstile.render('#moon-turnstile-widget', {
      sitekey: sitekey,
      theme: 'dark',
      callback: (token) => {
        window.__moonTurnstileToken = token;
        console.log('Turnstile token received:', token.slice(0, 30));
      },
      'error-callback': () => {
        window.__moonTurnstileError = true;
        console.log('Turnstile error');
      },
      'expired-callback': () => {
        window.__moonTurnstileExpired = true;
        console.log('Turnstile expired');
      },
    });
    return { success: true, widgetId };
  } catch (e) {
    return { error: e.message };
  }
}, SITEKEY);
console.log('render result:', JSON.stringify(widgetResult));

// Wait for Turnstile to solve
console.log('\n=== waiting for turnstile token ===');
let token = null;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  token = await page.evaluate(() => window.__moonTurnstileToken || null);
  const error = await page.evaluate(() => window.__moonTurnstileError || false);
  const expired = await page.evaluate(() => window.__moonTurnstileExpired || false);
  
  if (token) {
    console.log('token received! length:', token.length);
    break;
  }
  if (error) {
    console.log('turnstile error at attempt', i);
    break;
  }
  if (expired) {
    console.log('turnstile expired at attempt', i);
    break;
  }
  if (i % 5 === 0) console.log(`waiting... attempt ${i}`);
}

await page.screenshot({ path: 'moonptc_turnstile2.png', fullPage: false });

if (token) {
  // Click Claim now
  console.log('\n=== clicking Claim now ===');
  const claimBtn = page.locator('button:has-text("Claim now")');
  await claimBtn.click({ timeout: 10000 });
  await page.waitForTimeout(5000);
  
  const result = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('result:', result.replace(/\n+/g, ' | '));
  
  await page.screenshot({ path: 'moonptc_claimed.png', fullPage: false });
}

await context.close();