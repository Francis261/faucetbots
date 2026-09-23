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

// login
await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="email"]', EMAIL);
await page.click('button:has-text("Start Earning")', { timeout: 10000 });
await page.waitForTimeout(5000);
console.log('logged in');

// faucet
await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// explore the captcha div
console.log('\n=== captcha div exploration ===');
const ccDiv = await page.evaluate(() => {
  const d = document.querySelector('[data-cc-id]');
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return { html: d.outerHTML.slice(0, 500), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, children: d.children.length, innerHTML: d.innerHTML.slice(0, 300) };
});
console.log('cc div:', JSON.stringify(ccDiv, null, 1));

// explore all cc-related elements
const ccAll = await page.evaluate(() => {
  const els = document.querySelectorAll('[class*="cc-"], [data-cc-id], [data-format]');
  return [...els].map(e => ({ tag: e.tagName, cls: (e.className||'').slice(0, 60), html: e.outerHTML.slice(0, 200), rect: e.getBoundingClientRect() }));
});
console.log('cc elements:', JSON.stringify(ccAll, null, 1));

// check for captcha iframe
const captchaFrames = page.frames().filter(f => f.url() && !f.url().includes('moonptc') && f.url() !== 'about:blank');
console.log('\n=== captcha frames ===');
for (const frame of captchaFrames) {
  const url = frame.url();
  console.log('frame:', url.slice(0, 100));
  const content = await frame.evaluate(() => ({
    html: document.body?.innerHTML?.slice(0, 500) || '',
    iframes: [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 100)),
    images: [...document.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 100), w: i.width, h: i.height })),
    canvas: document.querySelectorAll('canvas').length,
    buttons: [...document.querySelectorAll('button, [role=button], [onclick]')].map(b => ({ text: (b.innerText||'').trim().slice(0, 40), cls: (b.className||'').slice(0, 40) })),
  })).catch(e => ({ error: e.message }));
  console.log('content:', JSON.stringify(content, null, 1));
}

// click on the cc div directly
console.log('\n=== clicking cc div ===');
const ccEl = page.locator('[data-cc-id]').first();
const ccBox = await ccEl.boundingBox();
console.log('cc box:', ccBox);

if (ccBox) {
  // click center of cc div
  await page.mouse.click(ccBox.x + ccBox.width / 2, ccBox.y + ccBox.height / 2);
  await page.waitForTimeout(5000);
  
  // check what happened
  const afterClick = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 120), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }));
    const modals = [...document.querySelectorAll('[role=dialog], .modal, [class*=modal], [class*=Modal]')].map(m => m.outerHTML.slice(0, 300));
    const newCcs = [...document.querySelectorAll('[class*="cc-"]')].map(e => ({ cls: (e.className||'').slice(0, 60), html: e.outerHTML.slice(0, 200) }));
    const body = document.body.innerText.slice(0, 500);
    return { iframes, modals, newCcs, body };
  });
  console.log('after click:', JSON.stringify(afterClick, null, 1));
  
  // check new frames
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url && url !== 'about:blank' && !url.includes('moonptc')) {
      const content = await frame.evaluate(() => document.body?.innerHTML?.slice(0, 500) || '').catch(() => '');
      if (content.length > 10) {
        console.log(`\nframe ${url.slice(0, 80)}:`, content.slice(0, 300));
      }
    }
  }
}

await page.screenshot({ path: 'moonptc_puzzle.png', fullPage: false });
console.log('\nscreenshot saved');
await context.close();