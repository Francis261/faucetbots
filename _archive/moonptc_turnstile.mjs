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
console.log('logged in, url:', page.url());

await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(5000);
console.log('faucet url:', page.url());

// Check for Turnstile widget
console.log('\n=== turnstile check ===');
const turnstileInfo = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')];
  const cfIframes = iframes.filter(f => f.src.includes('challenges.cloudflare.com') || f.src.includes('turnstile'));
  const allFrames = iframes.map(f => ({ src: f.src.slice(0, 120), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height, id: f.id, cls: (f.className||'').slice(0, 40) }));
  const hasTurnstile = typeof window.turnstile !== 'undefined';
  const siteKey = window.__TURNSTILE_SITEKEY__ || '';
  const widgetDiv = document.querySelector('[data-moon-turnstile], .cf-turnstile, [data-sitekey]');
  return { cfIframes: cfIframes.map(f => ({ src: f.src.slice(0, 150), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height })), allFrames, hasTurnstile, siteKey, widgetDiv: widgetDiv ? widgetDiv.outerHTML.slice(0, 200) : null };
});
console.log(JSON.stringify(turnstileInfo, null, 2));

// Try to find the Turnstile widget div and render it
const renderResult = await page.evaluate(() => {
  // Check if turnstile is already rendered
  if (window.turnstile) {
    const widgets = document.querySelectorAll('[data-moon-turnstile]');
    return { hasTurnstile: true, widgetCount: widgets.length, widgets: [...widgets].map(w => w.outerHTML.slice(0, 200)) };
  }
  return { hasTurnstile: false };
});
console.log('render result:', JSON.stringify(renderResult));

// Look for the "I'm not a robot" button and click it
console.log('\n=== clicking I am not a robot ===');
const robotBtn = page.locator('button:has-text("I\'m not a robot")');
const isVisible = await robotBtn.isVisible();
console.log('robot btn visible:', isVisible);

if (isVisible) {
  // Get the bounding box
  const box = await robotBtn.boundingBox();
  console.log('robot btn box:', box);
  
  // Check what element is at that position
  const elementAtPoint = await page.evaluate(({x, y}) => {
    const el = document.elementFromPoint(x, y);
    return { tag: el?.tagName, cls: (el?.className||'').slice(0, 60), id: el?.id, html: el?.outerHTML?.slice(0, 200) };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  console.log('element at click point:', JSON.stringify(elementAtPoint));
  
  // Try force clicking
  await robotBtn.click({ force: true, timeout: 10000 }).catch(e => console.log('force click error:', e.message.slice(0, 100)));
  await page.waitForTimeout(5000);
  
  // Check if Turnstile iframe appeared
  const afterClick = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')];
    const cfIframes = iframes.filter(f => f.src.includes('challenges.cloudflare.com') || f.src.includes('turnstile'));
    return cfIframes.map(f => ({ src: f.src.slice(0, 150), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }));
  });
  console.log('cf iframes after click:', JSON.stringify(afterClick));
}

await page.screenshot({ path: 'moonptc_turnstile.png', fullPage: false });
console.log('\nscreenshot saved');
await context.close();