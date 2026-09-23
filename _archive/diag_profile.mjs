import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE = join(homedir(), '.config/google-chrome');
const RESOLVER = 'MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41';

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1366, height: 768 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--host-resolver-rules=${RESOLVER}`],
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = context.pages()[0] || (await context.newPage());

page.on('response', r => {
  if (r.url().includes('/index') || r.status() === 403 || r.url().includes('challenge-platform')) {
    console.log('RES', r.status(), r.url().slice(0, 90));
  }
});

const CHECKBOX_SELECTORS = [
  '[role="checkbox"]',
  'input[type="checkbox"]',
  '.ctp-checkbox',
  '.ctp-checkbox-label',
  'label[class*="checkbox"]',
  '[class*="checkbox"]',
  '.challenge-box',
  '#challenge-stage button',
  'button[class*="ctp"]',
];

async function clickInFrame(frame) {
  for (const sel of CHECKBOX_SELECTORS) {
    const loc = frame.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      const vis = await loc.isVisible().catch(() => false);
      if (vis) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        console.log(`  [CLICKED] "${sel}" in ${frame === page.mainFrame() ? 'TOP' : 'iframe'}`);
        return true;
      }
    }
  }
  return false;
}

async function clickAnyCheckbox() {
  if (await clickInFrame(page.mainFrame())) return true;
  for (const f of page.frames()) {
    if (f !== page.mainFrame()) {
      if (await clickInFrame(f)) return true;
    }
  }
  return false;
}

async function hasLoginForm() {
  const c = await page.locator('input#addr, input#secret, #submit_btn, input[type="submit"]').count().catch(() => 0);
  return c >= 2;
}

console.log('Opening /index/enter with REAL PROFILE...');
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 40; i++) {
  if (await hasLoginForm()) {
    console.log(`>>> LOGIN FORM VISIBLE after ~${i * 5}s`);
    const dump = await page.evaluate(() =>
      [...document.querySelectorAll('input, button')].map(e => ({ tag: e.tagName, type: e.type, name: e.name, id: e.id }))
    );
    console.log(JSON.stringify(dump, null, 1));
    break;
  }
  const title = await page.title().catch(() => '');
  const clicked = await clickAnyCheckbox();
  if (i % 2 === 0) console.log(`iter ${i + 1}/40 (${(i + 1) * 5}s) title="${title}" clicked=${clicked}`);
  await page.waitForTimeout(5000);
}
if (!(await hasLoginForm())) {
  console.log('NO LOGIN FORM after 200s');
  const t = await page.evaluate(() => document.body?.innerText || '');
  console.log('body text:', t.slice(0, 300));
}
await context.close();
