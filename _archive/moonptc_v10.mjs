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

// Remove overlay
await page.evaluate(() => {
  document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove());
});
await page.waitForTimeout(1000);

// Click "I'm not a robot" button via JavaScript (bypasses overlay)
console.log('clicking robot button via JS...');
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('robot'));
  if (btn) btn.click();
});
await page.waitForTimeout(8000);

// Check if Turnstile loaded
const state = await page.evaluate(() => {
  const hasTurnstile = typeof window.turnstile !== 'undefined';
  const cfIframes = [...document.querySelectorAll('iframe')].filter(f => f.src.includes('challenges.cloudflare.com'));
  return { hasTurnstile, cfIframeCount: cfIframes.length, cfIframeSrcs: cfIframes.map(f => f.src.slice(0, 100)) };
});
console.log('state after click:', JSON.stringify(state));

// If Turnstile loaded, find and click the checkbox
if (state.hasTurnstile && state.cfIframeCount > 0) {
  console.log('Turnstile loaded, clicking checkbox...');
  
  // Find the Turnstile iframe position
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
    console.log('iframe pos:', iframePos);
    // Click checkbox (left side of widget)
    await page.mouse.click(iframePos.x + 28, iframePos.y + 33);
    console.log('clicked checkbox');
  }
}

// Wait for captcha token (check React state)
console.log('waiting for captcha token...');
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(2000);
  
  // Check if Claim button is enabled
  const btnState = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Claim now'));
    return btn ? { disabled: btn.disabled, text: btn.innerText } : null;
  });
  
  if (btnState && !btnState.disabled) {
    console.log('Claim button is ENABLED!');
    
    // Click Claim now
    await page.locator('button:has-text("Claim now")').click({ timeout: 10000 });
    await page.waitForTimeout(10000);
    
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('RESULT:', text.replace(/\n+/g, ' | '));
    await page.screenshot({ path: 'moonptc_final.png', fullPage: false });
    break;
  }
  
  if (i % 5 === 0) console.log('waiting...', i, 'btn disabled:', btnState?.disabled);
}

await page.screenshot({ path: 'moonptc_v10.png', fullPage: false });
await context.close();