import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESOLVER = 'MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41';
const userDataDir = mkdtempSync(join(tmpdir(), 'adbch-'));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1366, height: 768 },
  locale: 'en-US',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--host-resolver-rules=${RESOLVER}`],
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = context.pages()[0] || (await context.newPage());

const SELECTORS = [
  '[role="checkbox"]',
  'input[type="checkbox"]',
  '.ctp-checkbox',
  '.ctp-checkbox-label',
  'label[class*="checkbox"]',
  '[class*="checkbox"]',
  '.challenge-box',
  '[id*="challenge"] button',
  '#challenge-stage button',
  '.cf-turnstile input',
  'button[class*="ctp"]',
];

async function clickInFrame(frame) {
  for (const sel of SELECTORS) {
    const loc = frame.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      const vis = await loc.isVisible().catch(() => false);
      if (vis) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        console.log(`  CLICKED "${sel}" in ${frame === page.mainFrame() ? 'TOP' : 'frame'} (${frame.url().slice(0, 50)})`);
        return true;
      }
    }
  }
  return false;
}

async function clearChallenge(label) {
  for (let i = 0; i < 60; i++) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!title.includes('Just a moment') && !bodyText.includes('Performing security verification')) {
      console.log(`${label}: CHALLENGE CLEARED after ~${i * 5}s`);
      return true;
    }
    await clickInFrame(page.mainFrame());
    for (const f of page.frames()) {
      if (f !== page.mainFrame()) await clickInFrame(f);
    }
    await page.waitForTimeout(5000);
  }
  return false;
}

console.log('Opening /index/enter...');
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
await clearChallenge('login page');

console.log('--- DUMPING LOGIN FORM ---');
const formInfo = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input, textarea, select, button')].map(e => ({
    tag: e.tagName, type: e.type, name: e.name, id: e.id, cls: e.className, value: e.value, placeholder: e.placeholder,
  }));
  const forms = [...document.querySelectorAll('form')].map(f => ({ action: f.action, method: f.method, id: f.id, cls: f.className }));
  return { forms, inputs };
});
console.log(JSON.stringify(formInfo, null, 1));

await page.screenshot({ path: 'login-page.png' }).catch(() => {});
await context.close();
