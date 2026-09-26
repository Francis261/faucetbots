import { chromium } from 'playwright';
import { join } from 'node:path';

const BASE_URL = 'https://onlyfaucet.com';
const PROFILE = join(process.env.HOME, '.onlyfaucet-chrome-profile');
const EMAIL = process.env.LOGIN_EMAIL || 'francisdominic261@gmail.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${m}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  viewport: { width: 1280, height: 800 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

const snap = async (label) => {
  const info = await page.evaluate(() => ({
    url: location.href,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    wallet: !!document.querySelector('#walletInput'),
    walletVal: document.querySelector('#walletInput')?.value || '',
    turnstile: !!document.querySelector('.cf-turnstile'),
    turnstileToken: (document.querySelector('input[name="cf-turnstile-response"]')?.value || '').slice(0, 20),
    frames: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 70)),
    buttons: [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 10),
    forms: [...document.querySelectorAll('form')].map(f => f.action),
  })).catch(e => ({ error: e.message }));
  log(`${label}: ${JSON.stringify(info)}`);
  await page.screenshot({ path: `/tmp/onlyfaucet-login-${label}.png` }).catch(() => {});
  return info;
};

try {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);
  await snap('01-home');

  await page.click('text=Login / Register').catch(e => log('click err ' + e.message));
  await sleep(3000);
  await snap('02-after-login-click');

  await page.fill('#walletInput', EMAIL).catch(e => log('fill err ' + e.message));
  await sleep(1000);
  await snap('03-after-fill');

  // Turnstile present?
  const hasT = await page.evaluate(() => !!document.querySelector('.cf-turnstile'));
  if (hasT) {
    log('Turnstile present — clicking it');
    const box = await page.evaluate(() => {
      const el = document.querySelector('.cf-turnstile');
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y, { steps: 5 });
    await sleep(300);
    await page.mouse.click(box.x, box.y);
    await sleep(5000);
    await snap('04-after-turnstile');
  }

  await page.click('button:has-text("Continue"), button[type="submit"]').catch(e => log('submit err ' + e.message));
  await sleep(8000);
  await snap('05-after-continue');
  await sleep(8000);
  await snap('06-later');
} catch (e) {
  log('ERROR ' + (e.stack || e.message));
}
await ctx.close().catch(() => {});
process.exit(0);
