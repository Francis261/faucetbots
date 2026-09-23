import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, viewport: { width: 1366, height: 768 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://claimfreecoins.io/tether-faucet/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input#address', EMAIL);
await page.click('button[data-target="#captchaModal"]', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const m = document.querySelector('#captchaModal');
  if (m) {
    m.classList.add('show');
    m.style.display = 'block';
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop fade show';
    document.body.appendChild(bd);
  }
});
await page.waitForTimeout(1500);

const anchorFrame = page.frames().find(f => /api2\/anchor/.test(f.url()));
console.log('anchor frame:', anchorFrame ? anchorFrame.url().slice(0, 80) : 'NONE');

if (anchorFrame) {
  const info = await anchorFrame.evaluate(() => {
    const box = document.querySelector('.recaptcha-checkbox') || document.querySelector('#recaptcha-anchor');
    const labels = [...document.querySelectorAll('input, label, div')].slice(0, 20).map(e => ({
      tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 50), type: e.type,
    }));
    const r = box ? box.getBoundingClientRect() : null;
    return {
      boxExists: !!box,
      boxCls: box ? box.className : null,
      boxRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      bodyText: (document.body.innerText || '').slice(0, 100),
      firstEls: labels,
    };
  }).catch(e => ({ err: e.message.slice(0, 200) }));
  console.log(JSON.stringify(info, null, 1));
} else {
  console.log('no anchor frame; listing frames:');
  for (const f of page.frames()) console.log('  ', f.url().slice(0, 90));
}

await page.screenshot({ path: 'faucet_checkbox.png' }).catch(() => {});
await context.close();
