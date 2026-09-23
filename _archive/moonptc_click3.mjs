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
await page.waitForTimeout(5000);

// Wait for shadow DOM to appear and click inside it
console.log('=== waiting for shadow DOM ===');
for (let attempt = 0; attempt < 20; attempt++) {
  const result = await page.evaluate(() => {
    const allDivs = document.querySelectorAll('div');
    for (const d of allDivs) {
      if (d.shadowRoot) {
        const sr = d.shadowRoot;
        const rect = d.getBoundingClientRect();
        // look for checkbox or clickable element
        const checkbox = sr.querySelector('input[type=checkbox]');
        const labels = [...sr.querySelectorAll('label, span, div')].filter(e => e.innerText && e.innerText.includes('robot'));
        const allClickable = [...sr.querySelectorAll('input, button, label, [role=checkbox], [onclick]')];
        return {
          found: true,
          parentRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          html: sr.innerHTML.slice(0, 3000),
          hasCheckbox: !!checkbox,
          robotLabels: labels.map(l => ({ tag: l.tagName, text: l.innerText.slice(0, 30), rect: l.getBoundingClientRect() })),
          clickable: allClickable.map(e => ({ tag: e.tagName, type: e.type || '', cls: (e.className||'').slice(0, 40), rect: e.getBoundingClientRect() })),
        };
      }
    }
    return { found: false };
  });
  
  if (result.found) {
    console.log('attempt', attempt, ':', JSON.stringify(result, null, 2));
    
    // Try clicking the checkbox inside shadow DOM using page.evaluate
    if (result.hasCheckbox) {
      console.log('clicking checkbox via evaluate...');
      await page.evaluate(() => {
        const allDivs = document.querySelectorAll('div');
        for (const d of allDivs) {
          if (d.shadowRoot) {
            const cb = d.shadowRoot.querySelector('input[type=checkbox]');
            if (cb) cb.click();
          }
        }
      });
    } else if (result.robotLabels.length > 0) {
      // Click on the robot label area
      const label = result.robotLabels[0];
      const parentRect = result.parentRect;
      const clickX = parentRect.x + label.rect.x + label.rect.width / 2;
      const clickY = parentRect.y + label.rect.y + label.rect.height / 2;
      console.log('clicking robot label at', clickX, clickY);
      await page.mouse.click(clickX, clickY);
    } else if (result.clickable.length > 0) {
      const el = result.clickable[0];
      const parentRect = result.parentRect;
      const clickX = parentRect.x + el.rect.x + el.rect.width / 2;
      const clickY = parentRect.y + el.rect.y + el.rect.height / 2;
      console.log('clicking first clickable at', clickX, clickY);
      await page.mouse.click(clickX, clickY);
    }
    
    await page.waitForTimeout(5000);
    break;
  }
  await page.waitForTimeout(1000);
}

// Check result
console.log('\n=== result ===');
const afterClick = await page.evaluate(() => {
  const allDivs = document.querySelectorAll('div');
  for (const d of allDivs) {
    if (d.shadowRoot) {
      const sr = d.shadowRoot;
      return {
        html: sr.innerHTML.slice(0, 3000),
        images: [...sr.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 120), w: i.width, h: i.height })),
        canvas: sr.querySelectorAll('canvas').length,
        iframes: [...sr.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 150) })),
      };
    }
  }
  return { msg: 'no shadow root' };
});
console.log(JSON.stringify(afterClick, null, 2));

await page.screenshot({ path: 'moonptc_click3.png', fullPage: false });
console.log('\nscreenshot saved');
await context.close();