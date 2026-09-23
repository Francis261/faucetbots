import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'freelite-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://freelitecoin.online/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[name="faucet_email"]', EMAIL);
await page.waitForTimeout(3000);

await page.screenshot({ path: '/tmp/opencode/ffl_full.png' });
console.log('screenshot taken, viewport:', page.viewportSize());

// capture the captcha region
const cap = page.locator('.captcha-wrap');
const box = await cap.boundingBox().catch(() => null);
console.log('captcha box:', JSON.stringify(box));
if (box) {
  await page.screenshot({ path: '/tmp/opencode/ffl_captcha.png', clip: box });
}

// what elements are inside the widget?
const inner = await page.evaluate(() => {
  const el = document.querySelector('.cf-turnstile');
  const out = [];
  const visit = n => {
    out.push({ tag: n.tagName, cls: (n.className||'').slice(0,40), id: (n.id||'').slice(0,30), style: n.getAttribute?.('style')||'' });
    for (const c of n.children) visit(c);
  };
  if (el) visit(el);
  return out;
});
console.log('widget tree:', JSON.stringify(inner, null, 1).slice(0, 2000));

await context.close();