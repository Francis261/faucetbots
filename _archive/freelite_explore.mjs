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

// Step 1: Homepage - fill email + solve Turnstile + claim
console.log('=== step 1: homepage ===');
await page.goto('https://freelitecoin.online/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await page.fill('input[name="faucet_email"]', EMAIL);

let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
console.log('turnstile:', !!ts);
if (ts) {
  for (let i = 0; i < 10; i++) {
    const htmlLen = await ts.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
    if (htmlLen > 0) break;
    await page.waitForTimeout(1000);
  }
  await ts.locator('body').click({ position: { x: 25, y: 33 }, timeout: 5000 }).catch(e => console.log('ts click err:', e.message.slice(0, 60)));
  await page.waitForTimeout(3000);
}
const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
console.log('token:', tok);

// submit claim
await page.click('button[type="submit"]', { timeout: 10000 });
await page.waitForTimeout(5000);
console.log('after claim url:', page.url());

// Step 2: mine.php
console.log('\n=== step 2: mine.php ===');
await page.goto('https://freelitecoin.online/mine.php', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('mine url:', page.url());
const mineText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 1000);
console.log('mine text:', mineText.replace(/\n+/g, ' | '));
const mineButtons = await page.evaluate(() => [...document.querySelectorAll('button, a, input[type=submit], [onclick]')].map(b => ({
  tag: b.tagName, text: (b.innerText || (b.value||'') || '').trim().slice(0, 50), id: b.id, cls: (b.className||'').slice(0, 50), onclick: (b.getAttribute('onclick')||'').slice(0, 100),
})).slice(0, 25));
console.log('mine buttons:', JSON.stringify(mineButtons, null, 1));
const mineInputs = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea')].map(i => ({
  tag: i.tagName, type: i.type, name: i.name, id: i.id, value: (i.value||'').slice(0, 50),
})).slice(0, 15));
console.log('mine inputs:', JSON.stringify(mineInputs, null, 1));
// dump full page HTML structure
const mineStructure = await page.evaluate(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
  return els.filter(e => ['BUTTON','A','INPUT','SELECT','H1','H2','H3','SPAN','DIV','P'].includes(e.tagName)).slice(0, 60).map(e => ({
    tag: e.tagName, id: e.id, cls: (e.className||'').slice(0, 50), text: (e.innerText||'').trim().slice(0, 60), onclick: (e.getAttribute('onclick')||'').slice(0, 80),
  }));
});
console.log('mine structure:', JSON.stringify(mineStructure, null, 1));

// Step 3: dashboard.php
console.log('\n=== step 3: dashboard.php ===');
await page.goto('https://freelitecoin.online/dashboard.php', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('dash url:', page.url());
const dashText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 1000);
console.log('dash text:', dashText.replace(/\n+/g, ' | '));
const dashButtons = await page.evaluate(() => [...document.querySelectorAll('button, a, input[type=submit], [onclick]')].map(b => ({
  tag: b.tagName, text: (b.innerText || (b.value||'') || '').trim().slice(0, 50), id: b.id, cls: (b.className||'').slice(0, 50), onclick: (b.getAttribute('onclick')||'').slice(0, 100),
})).slice(0, 25));
console.log('dash buttons:', JSON.stringify(dashButtons, null, 1));
const dashStructure = await page.evaluate(() => {
  const els = [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
  return els.filter(e => ['BUTTON','A','INPUT','SELECT','H1','H2','H3','SPAN','DIV','P','LABEL'].includes(e.tagName)).slice(0, 60).map(e => ({
    tag: e.tagName, id: e.id, cls: (e.className||'').slice(0, 50), text: (e.innerText||'').trim().slice(0, 80),
  }));
});
console.log('dash structure:', JSON.stringify(dashStructure, null, 1));

await context.close();