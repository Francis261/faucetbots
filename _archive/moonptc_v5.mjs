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
    callback: function(token) { window.__myToken = token; },
    'error-callback': function() { window.__myError = 'error'; },
    'expired-callback': function() { window.__myExpired = true; },
  });
}, SITEKEY);
await page.waitForTimeout(5000);

// Find Turnstile iframe and click checkbox
console.log('looking for turnstile iframe...');
const turnstileFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
if (turnstileFrame) {
  console.log('found turnstile frame:', turnstileFrame.url().slice(0, 80));
  
  // Try to click the checkbox inside the frame
  try {
    const checkbox = turnstileFrame.locator('input[type=checkbox]');
    if (await checkbox.isVisible({ timeout: 5000 })) {
      console.log('clicking checkbox...');
      await checkbox.click({ timeout: 5000 });
    } else {
      // Try clicking the body of the frame
      console.log('clicking frame body...');
      await turnstileFrame.locator('body').click({ position: { x: 25, y: 25 }, timeout: 5000 });
    }
  } catch(e) {
    console.log('frame click error:', e.message.slice(0, 100));
    // Try mouse click on the iframe element position
    const iframeEl = await page.evaluate(() => {
      const iframes = [...document.querySelectorAll('iframe')];
      const cf = iframes.find(f => f.src.includes('challenges.cloudflare.com'));
      if (cf) {
        const r = cf.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return null;
    });
    if (iframeEl) {
      console.log('clicking at iframe position:', iframeEl);
      await page.mouse.click(iframeEl.x + 25, iframeEl.y + 25);
    }
  }
} else {
  console.log('no turnstile frame found');
}

// Wait for token
console.log('waiting for token...');
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const token = await page.evaluate(() => window.__myToken);
  if (token) {
    console.log('TOKEN! length:', token.length);
    
    // Click Claim now
    console.log('clicking Claim now...');
    await page.locator('button:has-text("Claim now")').click({ timeout: 5000 });
    await page.waitForTimeout(8000);
    
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('result:', text.replace(/\n+/g, ' | '));
    break;
  }
  if (i % 5 === 0) console.log('waiting...', i);
}

await page.screenshot({ path: 'moonptc_v5.png', fullPage: false });
await context.close();