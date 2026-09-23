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

// Remove overlay
await page.evaluate(() => {
  document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove());
});

// Load Turnstile
await page.addScriptTag({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' });
await page.waitForTimeout(3000);

// Render widget
console.log('rendering turnstile...');
await page.evaluate((sk) => {
  const container = document.createElement('div');
  container.id = 'my-turnstile';
  container.style.cssText = 'margin: 20px auto; text-align: center;';
  const claimBtn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Claim now'));
  if (claimBtn) claimBtn.parentElement.insertBefore(container, claimBtn);
  window.turnstile.render('#my-turnstile', {
    sitekey: sk,
    theme: 'dark',
    callback: function(token) { window.__myToken = token; console.log('TOKEN RECEIVED:', token.length); },
    'error-callback': function() { window.__myError = 'error'; },
    'expired-callback': function() { window.__myExpired = true; },
  });
}, SITEKEY);
await page.waitForTimeout(5000);

// Check if Turnstile auto-solved (sometimes it does)
let token = await page.evaluate(() => window.__myToken);
if (token) {
  console.log('auto-solved! token length:', token.length);
} else {
  console.log('not auto-solved, clicking checkbox...');
  
  // Try to find and click the Turnstile checkbox
  const turnstileFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
  if (turnstileFrame) {
    console.log('found turnstile frame');
    try {
      await turnstileFrame.locator('body').click({ position: { x: 25, y: 25 }, timeout: 5000 });
      console.log('clicked frame body');
    } catch(e) {
      console.log('frame click error:', e.message.slice(0, 100));
    }
  }
  
  // Also try mouse click on the widget area
  const widgetBox = await page.evaluate(() => {
    const el = document.getElementById('my-turnstile');
    if (el) {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return null;
  });
  if (widgetBox) {
    console.log('widget box:', widgetBox);
    await page.mouse.click(widgetBox.x + 28, widgetBox.y + 33);
    console.log('clicked widget area');
  }
}

// Wait for token
console.log('waiting for token...');
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(2000);
  token = await page.evaluate(() => window.__myToken);
  if (token) {
    console.log('TOKEN! length:', token.length);
    
    // Click Claim now
    console.log('clicking Claim now...');
    await page.locator('button:has-text("Claim now")').click({ timeout: 5000 });
    await page.waitForTimeout(10000);
    
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('RESULT:', text.replace(/\n+/g, ' | '));
    await page.screenshot({ path: 'moonptc_claimed.png', fullPage: false });
    break;
  }
  const error = await page.evaluate(() => window.__myError);
  if (error) { console.log('error:', error); break; }
  if (i % 5 === 0) console.log('waiting...', i);
}

await page.screenshot({ path: 'moonptc_v8.png', fullPage: false });
await context.close();