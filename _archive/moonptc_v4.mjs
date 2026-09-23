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

// Manually load Turnstile
console.log('loading turnstile...');
await page.addScriptTag({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' });
await page.waitForTimeout(3000);

const hasT = await page.evaluate(() => typeof window.turnstile);
console.log('turnstile type:', hasT);

if (hasT === 'object') {
  // Render widget
  console.log('rendering widget...');
  const renderResult = await page.evaluate((sk) => {
    const container = document.createElement('div');
    container.id = 'my-turnstile';
    container.style.cssText = 'margin: 20px auto; text-align: center;';
    
    // Insert before the Claim button
    const claimBtn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Claim now'));
    if (claimBtn) claimBtn.parentElement.insertBefore(container, claimBtn);
    
    try {
      const widgetId = window.turnstile.render('#my-turnstile', {
        sitekey: sk,
        theme: 'dark',
        callback: function(token) {
          window.__myToken = token;
        },
        'error-callback': function() {
          window.__myError = 'error';
        },
        'expired-callback': function() {
          window.__myExpired = true;
        },
      });
      return { ok: true, widgetId };
    } catch(e) {
      return { error: e.message };
    }
  }, SITEKEY);
  console.log('render:', JSON.stringify(renderResult));

  // Wait for token
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const token = await page.evaluate(() => window.__myToken);
    const error = await page.evaluate(() => window.__myError);
    if (token) {
      console.log('TOKEN! length:', token.length);
      
      // Click Claim now
      await page.locator('button:has-text("Claim now")').click({ timeout: 5000 });
      await page.waitForTimeout(5000);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log('after claim:', text.replace(/\n+/g, ' | '));
      break;
    }
    if (error) { console.log('error:', error); break; }
    if (i % 5 === 0) console.log('waiting...', i);
  }
}

await page.screenshot({ path: 'moonptc_v4.png', fullPage: false });
await context.close();