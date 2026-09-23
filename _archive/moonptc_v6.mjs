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

// Find Turnstile iframe and click checkbox
console.log('looking for turnstile iframe...');
const turnstileFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
if (turnstileFrame) {
  console.log('found turnstile frame:', turnstileFrame.url().slice(0, 80));
  
  // Explore frame content
  const frameContent = await turnstileFrame.evaluate(() => ({
    html: document.body?.innerHTML?.slice(0, 1000) || '',
    checkbox: !!document.querySelector('input[type=checkbox]'),
    labels: [...document.querySelectorAll('label, span')].map(l => ({ text: l.innerText?.slice(0, 30), tag: l.tagName })).slice(0, 10),
  })).catch(e => ({ error: e.message }));
  console.log('frame content:', JSON.stringify(frameContent, null, 2));
  
  // Try clicking checkbox
  try {
    const checkbox = turnstileFrame.locator('input[type=checkbox]');
    if (await checkbox.count() > 0) {
      console.log('found checkbox, clicking...');
      await checkbox.click({ timeout: 5000 });
    } else {
      console.log('no checkbox found, trying label...');
      const label = turnstileFrame.locator('label').first();
      if (await label.isVisible({ timeout: 3000 })) {
        await label.click({ timeout: 5000 });
      }
    }
  } catch(e) {
    console.log('click error:', e.message.slice(0, 150));
  }
  
  // Also try clicking the iframe element on the page
  const iframePos = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')];
    const cf = iframes.find(f => f.src.includes('challenges.cloudflare.com'));
    if (cf) {
      const r = cf.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return null;
  });
  if (iframePos) {
    console.log('iframe position:', iframePos);
    // Click at checkbox position (usually near left side of widget)
    const clickX = iframePos.x + 28;
    const clickY = iframePos.y + 28;
    console.log('mouse click at', clickX, clickY);
    await page.mouse.click(clickX, clickY);
  }
}

// Wait for token
console.log('waiting for token...');
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const token = await page.evaluate(() => window.__myToken);
  if (token) {
    console.log('TOKEN! length:', token.length);
    await page.locator('button:has-text("Claim now")').click({ timeout: 5000 });
    await page.waitForTimeout(8000);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('result:', text.replace(/\n+/g, ' | '));
    break;
  }
  if (i % 5 === 0) console.log('waiting...', i);
}

await page.screenshot({ path: 'moonptc_v6.png', fullPage: false });
await context.close();