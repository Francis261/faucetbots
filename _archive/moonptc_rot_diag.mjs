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

// Click "I'm not a robot" via JS
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('robot'));
  if (btn) btn.click();
});
await page.waitForTimeout(8000);

// Check for rotation puzzle
console.log('=== checking for rotation puzzle ===');
const puzzleInfo = await page.evaluate(() => {
  const body = document.body.innerText;
  const allImgs = [...document.querySelectorAll('img')].map(i => ({
    src: i.src.slice(0, 120), w: i.width, h: i.height,
    style: i.style.cssText.slice(0, 100), cls: (i.className||'').slice(0, 50),
    parentCls: (i.parentElement?.className||'').slice(0, 50),
  }));
  const canvases = document.querySelectorAll('canvas');
  const sliders = document.querySelectorAll('input[type=range], [class*=slider], [class*=Slider], [class*=drag], [class*=Drag], [class*=rotate], [class*=Rotate]');
  const svgs = document.querySelectorAll('svg');
  
  // Look for rotation-related elements
  const rotationEls = [...document.querySelectorAll('*')].filter(e => {
    const cls = (e.className || '').toString().toLowerCase();
    const style = e.style.cssText.toLowerCase();
    return cls.includes('rotat') || cls.includes('slider') || cls.includes('drag') || cls.includes('puzzle') || cls.includes('challenge') || style.includes('rotate') || style.includes('cursor: grab');
  }).map(e => ({
    tag: e.tagName, cls: (e.className || '').toString().slice(0, 60),
    html: e.outerHTML.slice(0, 300), text: (e.innerText || '').trim().slice(0, 50),
  }));
  
  return {
    bodyText: body.slice(0, 500),
    imgs: allImgs.filter(i => i.w > 30),
    canvasCount: canvases.length,
    sliderCount: sliders.length,
    svgCount: svgs.length,
    rotationEls: rotationEls.slice(0, 10),
  };
});
console.log(JSON.stringify(puzzleInfo, null, 2));

// Also check for any new modals/dialogs
const modals = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[role=dialog], [class*=modal], [class*=Modal], [class*=popup], [class*=overlay], [class*=challenge], [class*=puzzle]')];
  return els.map(e => ({
    tag: e.tagName, cls: (e.className || '').toString().slice(0, 80),
    html: e.outerHTML.slice(0, 500), visible: e.getBoundingClientRect().width > 0,
  }));
});
console.log('\nmodals:', JSON.stringify(modals, null, 2));

await page.screenshot({ path: 'moonptc_rotation.png', fullPage: false });
console.log('\nscreenshot saved');
await context.close();