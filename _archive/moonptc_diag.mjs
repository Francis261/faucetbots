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

// Step 1: Homepage
console.log('=== step 1: homepage ===');
await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('url:', page.url());
const homeText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 600);
console.log('home text:', homeText.replace(/\n+/g, ' | '));
const homeButtons = await page.evaluate(() => [...document.querySelectorAll('button, a, input')].map(b => ({
  tag: b.tagName, text: (b.innerText || (b.value||'') || '').trim().slice(0, 40), id: b.id, href: b.href || '', cls: (b.className||'').slice(0, 40),
})).slice(0, 25));
console.log('buttons:', JSON.stringify(homeButtons, null, 1));

// Step 2: Login page
console.log('\n=== step 2: login ===');
await page.goto('https://moonptc.com/login', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('login url:', page.url());
const loginText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 600);
console.log('login text:', loginText.replace(/\n+/g, ' | '));
const loginInputs = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea')].map(i => ({
  tag: i.tagName, type: i.type, name: i.name, id: i.id, placeholder: i.placeholder || '', cls: (i.className||'').slice(0, 40),
})).slice(0, 15));
console.log('login inputs:', JSON.stringify(loginInputs, null, 1));
const loginButtons = await page.evaluate(() => [...document.querySelectorAll('button, a, input[type=submit]')].map(b => ({
  tag: b.tagName, text: (b.innerText || (b.value||'') || '').trim().slice(0, 40), id: b.id, cls: (b.className||'').slice(0, 40),
})).slice(0, 15));
console.log('login buttons:', JSON.stringify(loginButtons, null, 1));

// Step 3: Faucet page
console.log('\n=== step 3: faucet ===');
await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('faucet url:', page.url());
const faucetText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 800);
console.log('faucet text:', faucetText.replace(/\n+/g, ' | '));
const faucetButtons = await page.evaluate(() => [...document.querySelectorAll('button, a, input')].map(b => ({
  tag: b.tagName, text: (b.innerText || (b.value||'') || '').trim().slice(0, 40), id: b.id, cls: (b.className||'').slice(0, 40),
})).slice(0, 20));
console.log('faucet buttons:', JSON.stringify(faucetButtons, null, 1));

// Check for captcha
const captchaInfo = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 80), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }));
  const turnstile = document.querySelector('.cf-turnstile, [data-sitekey]');
  const recaptcha = document.querySelector('.g-recaptcha, [data-sitekey]');
  return { iframes, hasTurnstile: !!turnstile, hasRecaptcha: !!recaptcha, turnstileHtml: turnstile?.outerHTML?.slice(0, 200) || '' };
});
console.log('captcha info:', JSON.stringify(captchaInfo, null, 1));

await context.close();