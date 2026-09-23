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
await page.evaluate((sk) => {
  const container = document.createElement('div');
  container.id = 'my-turnstile';
  container.style.cssText = 'margin: 20px auto; text-align: center;';
  const claimBtn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Claim now'));
  if (claimBtn) claimBtn.parentElement.insertBefore(container, claimBtn);
  window.turnstile.render('#my-turnstile', {
    sitekey: sk,
    theme: 'dark',
    callback: function(token) { window.__myToken = token; },
    'error-callback': function() { window.__myError = 'error'; },
    'expired-callback': function() { window.__myExpired = true; },
  });
}, SITEKEY);
await page.waitForTimeout(5000);

// Get exact iframe position
const iframePos = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')];
  const cf = iframes.find(f => f.src.includes('challenges.cloudflare.com'));
  if (cf) {
    const r = cf.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return null;
});
console.log('iframe position:', iframePos);

if (iframePos) {
  // The checkbox in Turnstile is typically at the left side of the widget
  // Standard Turnstile widget is 300x65, checkbox is at about x=28, y=33
  const checkboxX = iframePos.x + 28;
  const checkboxY = iframePos.y + 33;
  
  console.log('clicking checkbox at', checkboxX, checkboxY);
  
  // Use mouse.move first, then mouse.down/up to simulate real click
  await page.mouse.move(checkboxX, checkboxY);
  await page.waitForTimeout(500);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  
  await page.waitForTimeout(10000);
  
  // Check token
  const token = await page.evaluate(() => window.__myToken);
  if (token) {
    console.log('TOKEN! length:', token.length);
    
    // Click Claim now
    await page.locator('button:has-text("Claim now")').click({ timeout: 5000 });
    await page.waitForTimeout(8000);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('result:', text.replace(/\n+/g, ' | '));
  } else {
    console.log('no token yet, checking error...');
    const error = await page.evaluate(() => window.__myError);
    console.log('error:', error);
    
    // Try clicking again
    console.log('retrying click...');
    await page.mouse.click(checkboxX, checkboxY);
    await page.waitForTimeout(10000);
    const token2 = await page.evaluate(() => window.__myToken);
    if (token2) {
      console.log('TOKEN on retry! length:', token2.length);
      await page.locator('button:has-text("Claim now")').click({ timeout: 5000 });
      await page.waitForTimeout(8000);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log('result:', text.replace(/\n+/g, ' | '));
    } else {
      console.log('still no token');
    }
  }
}

await page.screenshot({ path: 'moonptc_v7.png', fullPage: false });
await context.close();