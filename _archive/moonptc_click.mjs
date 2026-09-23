import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'moonptc-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

// login
console.log('=== login ===');
await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="email"]', EMAIL);
await page.click('button:has-text("Start Earning")', { timeout: 10000 });
await page.waitForTimeout(5000);
console.log('logged in, url:', page.url());

// go to faucet
console.log('\n=== faucet ===');
await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// click "I'm not a robot"
console.log('\n=== clicking I am not a robot ===');
const robotBtn = page.locator('button:has-text("I\'m not a robot")');
const btnVisible = await robotBtn.isVisible();
console.log('robot btn visible:', btnVisible);

// get button state before click
const btnHtml = await robotBtn.evaluate(e => e.outerHTML).catch(() => '');
console.log('btn html:', btnHtml.slice(0, 200));

// listen for new iframes
page.on('frameattached', async frame => {
  console.log('new frame attached:', frame.url().slice(0, 100));
});

// listen for popup/modal
page.on('dialog', async d => { console.log('dialog:', d.type(), d.message().slice(0, 100)); await d.accept(); });

await robotBtn.click({ timeout: 10000 });
await page.waitForTimeout(5000);

// check what changed
console.log('\n=== after click ===');
const newUrl = page.url();
console.log('url:', newUrl);

// check for new elements
const afterClick = await page.evaluate(() => {
  const modals = document.querySelectorAll('[role=dialog], .modal, [class*=modal], [class*=Modal], [class*=popup], [class*=Popup], [class*=overlay], [class*=Overlay]');
  const iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 120), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height, id: f.id, cls: (f.className||'').slice(0, 40) }));
  const buttons = [...document.querySelectorAll('button')].map(b => ({ text: (b.innerText||'').trim().slice(0, 50), cls: (b.className||'').slice(0, 50), visible: b.getBoundingClientRect().width > 0 })).filter(b => b.visible);
  return { modals: [...modals].map(m => m.outerHTML.slice(0, 300)), iframes, buttons };
});
console.log('after click:', JSON.stringify(afterClick, null, 1));

// check iframes content
for (const frame of page.frames()) {
  const furl = frame.url();
  if (furl && furl !== 'about:blank' && !furl.includes('moonptc')) {
    const content = await frame.evaluate(() => document.body?.innerHTML || '').catch(() => '');
    if (content.length > 10) {
      console.log(`\nframe ${furl.slice(0, 80)}:`, content.slice(0, 300));
    }
  }
}

// take screenshot
await page.screenshot({ path: 'moonptc_after_robot.png', fullPage: false });
console.log('\nscreenshot saved to moonptc_after_robot.png');

// check for canvas/images (puzzle)
const puzzleInfo = await page.evaluate(() => {
  const canvases = document.querySelectorAll('canvas');
  const imgs = [...document.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 80), w: i.width, h: i.height }));
  return { canvases: canvases.length, imgs: imgs.filter(i => i.w > 50) };
});
console.log('puzzle info:', JSON.stringify(puzzleInfo, null, 1));

await context.close();