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

// Step 1: Enter email on homepage
console.log('=== step 1: enter email ===');
await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="email"]', EMAIL);
console.log('email filled');

// click Start Earning
await page.click('button:has-text("Start Earning")', { timeout: 10000 });
await page.waitForTimeout(5000);
console.log('after start earning url:', page.url());

// check cookies
const cookies = await context.cookies('https://moonptc.com');
console.log('cookies:', cookies.map(c => `${c.name}=${c.value.slice(0, 20)}`).join(', '));

// Step 2: Navigate to faucet
console.log('\n=== step 2: faucet ===');
await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('faucet url:', page.url());
const faucetText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 1000);
console.log('faucet text:', faucetText.replace(/\n+/g, ' | '));

// dump all interactive elements
const faucetEls = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, a, input, [role=button], [onclick]')];
  return els.map(e => ({
    tag: e.tagName, text: (e.innerText || (e.value||'') || '').trim().slice(0, 50),
    id: e.id, cls: (e.className||'').slice(0, 50), href: e.href || '',
  })).slice(0, 30);
});
console.log('faucet elements:', JSON.stringify(faucetEls, null, 1));

// check for captcha
const captchaInfo = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 100), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }));
  const turnstile = document.querySelector('.cf-turnstile, [data-sitekey]');
  const recaptcha = document.querySelector('.g-recaptcha, [data-sitekey]');
  const checkbox = document.querySelector('input[type=checkbox]');
  return { iframes, hasTurnstile: !!turnstile, hasRecaptcha: !!recaptcha, hasCheckbox: !!checkbox, turnstileHtml: turnstile?.outerHTML?.slice(0, 300) || '' };
});
console.log('captcha info:', JSON.stringify(captchaInfo, null, 1));

// dump page structure
const structure = await page.evaluate(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
  return els.filter(e => ['BUTTON','A','INPUT','H1','H2','H3','LABEL','DIV','SPAN','P'].includes(e.tagName)).slice(0, 50).map(e => ({
    tag: e.tagName, id: e.id, cls: (e.className||'').slice(0, 50), text: (e.innerText||'').trim().slice(0, 60),
  }));
});
console.log('structure:', JSON.stringify(structure, null, 1));

await context.close();