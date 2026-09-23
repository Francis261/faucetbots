import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
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
await page.waitForTimeout(1500);
await page.fill('input[name="faucet_email"]', EMAIL);
await page.waitForTimeout(4000);

// Inspect shadow DOM inside .cf-turnstile
const shadow = await page.evaluate(() => {
  const el = document.querySelector('.cf-turnstile');
  const results = [];
  const walk = (node, depth, path) => {
    const sr = node.shadowRoot;
    if (sr) {
      results.push({ path, hasShadow: true, children: sr.children.length });
      for (const c of sr.children) walk(c, depth + 1, path + '>sr');
    }
    const info = { tag: node.tagName, path };
    if (node.getAttribute) {
      info.cls = (node.getAttribute('class') || '').slice(0, 50);
      info.id = (node.getAttribute('id') || '').slice(0, 30);
      info.role = node.getAttribute('role') || '';
    }
    results.push(info);
    if (node.tagName === 'IFRAME') info.src = (node.src || '').slice(0, 100);
    for (const c of node.children) walk(c, depth + 1, path + '/' + node.tagName);
  };
  if (el) walk(el, 0, '.cf-turnstile');
  return results.slice(0, 80);
});
console.log('shadow tree:', JSON.stringify(shadow, null, 1).slice(0, 3000));

// Also list any open contexts and their frame URLs
console.log('frames:', page.frames().map(f => f.url().slice(0, 80)));

await context.close();