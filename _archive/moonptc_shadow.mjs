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

await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// Explore shadow DOM deeply
const shadowInfo = await page.evaluate(() => {
  const allDivs = document.querySelectorAll('div');
  const results = [];
  for (const d of allDivs) {
    if (d.shadowRoot) {
      const sr = d.shadowRoot;
      results.push({
        parentCls: (d.className || '').slice(0, 80),
        parentTag: d.tagName,
        parentAttrs: [...d.attributes].map(a => a.name + '=' + a.value.slice(0, 30)).join(', '),
        shadowChildCount: sr.children.length,
        shadowHTML: sr.innerHTML.slice(0, 1500),
        shadowIframes: [...sr.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 150), w: f.width, h: f.height })),
        shadowButtons: [...sr.querySelectorAll('button, [role=button], input[type=checkbox], label, span')].map(b => ({
          tag: b.tagName, text: (b.innerText || b.value || '').trim().slice(0, 50),
          cls: (b.className || '').slice(0, 60), id: b.id,
        })),
        shadowInputs: [...sr.querySelectorAll('input, textarea')].map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: (i.placeholder || '').slice(0, 40),
        })),
        shadowImages: [...sr.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 100), w: i.width, h: i.height })),
        shadowCanvas: sr.querySelectorAll('canvas').length,
      });
    }
  }
  return results;
});
console.log(JSON.stringify(shadowInfo, null, 2));

// Also check global captcha variables
const globals = await page.evaluate(() => {
  return {
    ccnsUnits: JSON.stringify(window._ccnsUnitsToLoad).slice(0, 500),
    ccnsPop: window._ccnsPop,
    ccnsInit: window._ccnsLoaderInitialized,
  };
});
console.log('\nglobals:', JSON.stringify(globals, null, 2));

await page.screenshot({ path: 'moonptc_shadow.png', fullPage: false });
await context.close();