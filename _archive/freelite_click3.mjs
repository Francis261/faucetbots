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
await page.waitForTimeout(3000);
await page.fill('input[name="faucet_email"]', EMAIL);

// Wait for Turnstile frame
let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
if (!ts) { console.log('no turnstile frame'); await context.close(); process.exit(1); }

console.log('turnstile frame found:', ts.url().slice(0, 90));

// Wait for the frame to actually load content (might take 10-20 seconds)
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const htmlLen = ts ? await ts.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0) : 0;
  const title = ts ? await ts.evaluate(() => document.title || '').catch(() => '') : '';
  const bodyText = ts ? await ts.evaluate(() => document.body?.innerText?.slice(0, 100) || '').catch(() => '') : '';
  console.log(`[${i}] htmlLen=${htmlLen} title="${title}" body="${bodyText}"`);
  
  if (htmlLen > 100) {
    // Frame has loaded content - inspect it
    const elements = await ts.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && e.tagName !== 'HTML' && e.tagName !== 'BODY' && e.tagName !== 'STYLE' && e.tagName !== 'SCRIPT';
      }).map(e => ({ tag: e.tagName, id: e.id, cls: (e.className||'').slice(0,40), x: Math.round(e.getBoundingClientRect().x), y: Math.round(e.getBoundingClientRect().y), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }));
    });
    console.log('visible elements:', JSON.stringify(elements, null, 1));
    break;
  }
}

// Try clicking inside the frame using frame-level approach
// The Turnstile checkbox is typically a div with role="checkbox" or a clickable area
try {
  // Try clicking at the checkbox position (center-left of frame)
  const frameBox = await ts.evaluate(() => {
    const body = document.body;
    return body ? { w: body.getBoundingClientRect().width, h: body.getBoundingClientRect().height } : null;
  });
  console.log('frame body size:', JSON.stringify(frameBox));
  
  // The checkbox is at roughly (25, 33) inside the frame
  // Click on the frame at that position
  const checkbox = ts.locator('#cf-chl-widget-1_response, [role="checkbox"], input[type=checkbox]');
  const chkCount = await checkbox.count().catch(() => 0);
  console.log('checkbox elements in frame:', chkCount);
  
  // Try clicking the frame body at the checkbox position
  await ts.locator('body').click({ position: { x: 25, y: 33 }, timeout: 5000 }).catch(e => console.log('body click:', e.message.slice(0, 60)));
  await page.waitForTimeout(3000);
  console.log('token after frame click:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
} catch(e) {
  console.log('frame interaction err:', e.message.slice(0, 100));
}

// wait and poll token
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(2000);
  const tok = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  if (i % 5 === 0) console.log(`final wait[${i}] token=${tok}`);
  if (tok > 20) { console.log('GOT TOKEN!'); break; }
}

await context.close();