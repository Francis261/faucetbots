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

// Find and click the checkbox inside the shadow DOM
console.log('=== clicking captcha checkbox ===');
const clicked = await page.evaluate(() => {
  const allDivs = document.querySelectorAll('div');
  for (const d of allDivs) {
    if (d.shadowRoot) {
      const sr = d.shadowRoot;
      // look for checkbox input or clickable element
      const checkbox = sr.querySelector('input[type=checkbox]');
      if (checkbox) {
        checkbox.click();
        return { method: 'checkbox', found: true };
      }
      // look for any clickable element with "robot" text
      const allEls = sr.querySelectorAll('*');
      for (const el of allEls) {
        if (el.innerText && el.innerText.includes('robot')) {
          el.click();
          return { method: 'robot-text', tag: el.tagName, text: el.innerText.slice(0, 50) };
        }
      }
      // try clicking the first interactive element
      const btn = sr.querySelector('button, [role=button], label, span[class*=check]');
      if (btn) {
        btn.click();
        return { method: 'btn', tag: btn.tagName, cls: (btn.className||'').slice(0, 50) };
      }
      return { found: false, html: sr.innerHTML.slice(0, 300) };
    }
  }
  return { found: false, msg: 'no shadow root' };
});
console.log('click result:', JSON.stringify(clicked));
await page.waitForTimeout(5000);

// Check for puzzle after click
console.log('\n=== after click state ===');
const afterClick = await page.evaluate(() => {
  const results = [];
  const allDivs = document.querySelectorAll('div');
  for (const d of allDivs) {
    if (d.shadowRoot) {
      const sr = d.shadowRoot;
      results.push({
        html: sr.innerHTML.slice(0, 2000),
        iframes: [...sr.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 150), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height })),
        images: [...sr.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 120), w: i.width, h: i.height })),
        canvas: sr.querySelectorAll('canvas').length,
        buttons: [...sr.querySelectorAll('button, [role=button], label, span')].map(b => ({
          tag: b.tagName, text: (b.innerText || '').trim().slice(0, 50),
          cls: (b.className || '').slice(0, 60),
        })),
        inputs: [...sr.querySelectorAll('input')].map(i => ({ type: i.type, name: i.name })),
      });
    }
  }
  return results;
});
console.log(JSON.stringify(afterClick, null, 2));

await page.screenshot({ path: 'moonptc_after_click.png', fullPage: false });
console.log('\nscreenshot saved');

// Try clicking with mouse at the checkbox position visible in screenshot
// The checkbox appears to be at roughly x=693, y=367 based on the screenshot
console.log('\n=== mouse click at checkbox position ===');
await page.mouse.click(693, 367);
await page.waitForTimeout(5000);

const afterMouse = await page.evaluate(() => {
  const allDivs = document.querySelectorAll('div');
  for (const d of allDivs) {
    if (d.shadowRoot) {
      return {
        html: d.shadowRoot.innerHTML.slice(0, 2000),
        images: [...d.shadowRoot.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 120), w: i.width, h: i.height })),
        canvas: d.shadowRoot.querySelectorAll('canvas').length,
      };
    }
  }
  return { msg: 'no shadow root' };
});
console.log(JSON.stringify(afterMouse, null, 2));

await page.screenshot({ path: 'moonptc_after_mouse.png', fullPage: false });
await context.close();