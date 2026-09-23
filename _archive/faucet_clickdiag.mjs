import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://claimfreecoins.io/tether-faucet/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input#address', EMAIL).catch(() => {});
await page.click('button[data-target="#captchaModal"]', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(2000);

// force open modal
await page.evaluate(() => {
  const m = document.querySelector('#captchaModal');
  if (m) { m.classList.add('show'); m.style.display = 'block';
    const bd = document.createElement('div'); bd.className = 'modal-backdrop fade show'; document.body.appendChild(bd); }
});
await page.waitForTimeout(1500);

console.log('--- frames ---');
for (const f of page.frames()) console.log('  ', f.url().slice(0, 90));

const anchor = page.frames().find(f => /api2\/anchor/.test(f.url()));
console.log('anchor frame:', anchor ? 'FOUND' : 'MISSING');
if (anchor) {
  const before = await anchor.evaluate(() => {
    const box = document.querySelector('.recaptcha-checkbox');
    const r = box ? box.getBoundingClientRect() : null;
    return {
      box: box ? box.className : 'none',
      rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      errText: document.querySelector('.rc-anchor-error-msg-container, #rc-anchor-alert, [id*="error"], [id*="alert"]')?.innerText || '',
      quotaText: document.body.innerText || '',
    };
  });
  console.log('before:', JSON.stringify(before, null, 1));

  // Try clicking at its coordinates directly on the page mouse
  const bbox = before.rect;
  if (bbox) {
    // click at center of checkbox
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    console.log(`clicking at ${cx},${cy}`);
    await page.mouse.click(cx, cy).catch(e => console.log('mouse click err', e.message.slice(0, 80)));
  } else {
    // fallback: force click via locator
    console.log('no rect, using force click');
    await anchor.locator('.recaptcha-checkbox').first().click({ force: true }).catch(e => console.log('force click:', e.message.slice(0, 80)));
  }

  await page.waitForTimeout(5000);

  const after = await anchor.evaluate(() => {
    const box = document.querySelector('.recaptcha-checkbox');
    return {
      box: box ? box.className : 'none',
      checkedCls: document.querySelectorAll('.recaptcha-checkbox-checked').length,
      bodyText: document.body.innerText || '',
    };
  });
  console.log('after:', JSON.stringify(after, null, 1));

  const resp = await page.locator('#g-recaptcha-response').inputValue().catch(() => '');
  console.log('g-recaptcha-response len:', resp.length);
}
await context.close();