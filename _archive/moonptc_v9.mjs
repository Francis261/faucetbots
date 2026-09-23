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

// Render widget with callback that injects into React state
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
    callback: function(token) {
      window.__myToken = token;
      // Try to enable the Claim button by removing disabled attribute
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Claim now'));
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('disabled');
      }
    },
    'error-callback': function() { window.__myError = 'error'; },
    'expired-callback': function() { window.__myExpired = true; },
  });
}, SITEKEY);
await page.waitForTimeout(5000);

// Click widget area
const widgetBox = await page.evaluate(() => {
  const el = document.getElementById('my-turnstile');
  if (el) { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }
  return null;
});
if (widgetBox) {
  await page.mouse.click(widgetBox.x + 28, widgetBox.y + 33);
  console.log('clicked widget');
}

// Wait for token
console.log('waiting for token...');
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(2000);
  const token = await page.evaluate(() => window.__myToken);
  if (token) {
    console.log('TOKEN! length:', token.length);
    
    // Option 1: Try clicking Claim now (with force)
    console.log('trying to click Claim now...');
    const claimBtn = page.locator('button:has-text("Claim now")');
    await claimBtn.evaluate(btn => { btn.disabled = false; btn.removeAttribute('disabled'); });
    await claimBtn.click({ force: true, timeout: 5000 }).catch(e => console.log('click error:', e.message.slice(0, 80)));
    await page.waitForTimeout(5000);
    
    // Check if it worked
    let text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('after click attempt 1:', text.replace(/\n+/g, ' | ').slice(0, 200));
    
    // Option 2: If button click didn't work, call API directly
    const result = await page.evaluate(async (t) => {
      try {
        const resp = await fetch('/api/faucet/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ captcha_token: t }),
        });
        return await resp.json();
      } catch(e) {
        return { error: e.message };
      }
    }, token);
    console.log('API result:', JSON.stringify(result));
    
    if (result.ok) {
      console.log('CLAIMED! Reward:', result.finalReward, 'Roll:', result.roll);
      // Wait for balance update
      await page.waitForTimeout(3000);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
      const newBalance = await page.evaluate(() => document.body.innerText.match(/Balance[\s\S]*?(\d+)/)?.[1] || '');
      console.log('new balance:', newBalance);
    }
    
    await page.screenshot({ path: 'moonptc_claimed.png', fullPage: false });
    break;
  }
  const error = await page.evaluate(() => window.__myError);
  if (error) { console.log('error:', error); break; }
  if (i % 5 === 0) console.log('waiting...', i);
}

await context.close();