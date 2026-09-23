import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';

const EMAIL = 'francisdominic261@gmail.com';
const PROFILE = '/home/francis/.config/google-chrome';
const COOKIE_FILE = process.argv[2] || null;

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport: null,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

// optionally inject freelite cookies if provided
if (COOKIE_FILE && existsSync(COOKIE_FILE)) {
  const cookies = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
  await context.addCookies(cookies);
  console.log('injected', cookies.length, 'cookies from', COOKIE_FILE);
}

console.log('=== homepage with real profile ===');
await page.goto('https://freelitecoin.online/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[name="faucet_email"]', EMAIL).catch(() => {});

let ts;
for (let i = 0; i < 12 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
console.log('turnstile frame:', !!ts);

// poll title / token
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1500);
  const info = ts ? await ts.evaluate(() => ({
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 150),
    visEls: [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().width > 5 && e.getBoundingClientRect().height > 5 && e.tagName !== 'HTML' && e.tagName !== 'BODY' && e.tagName !== 'STYLE').slice(0, 8).map(e => ({ tag: e.tagName, cls: (e.className||'').slice(0, 40) })),
  })).catch(() => ({})) : {};
  const token = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  console.log(`[poll ${i}] title="${info.title}" token=${token} els=${JSON.stringify(info.visEls||[])}`);
  if (token > 20) { console.log('TOKEN GOT'); break; }
}

// try clicking like a checkbox if there's visible stuff
const box = await page.evaluate(() => {
  for (const f of document.querySelectorAll('iframe')) {
    if ((f.src || '').includes('turnstile')) { const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }
  }
  return null;
});
console.log('ts box:', JSON.stringify(box));
if (box && box.w > 0) {
  const cx = box.x + 20, cy = box.y + box.h / 2;
  await page.mouse.move(cx, cy); await page.waitForTimeout(200); await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
  await page.waitForTimeout(3000);
  console.log('token after click:', (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length);
}

console.log('cookies now:', (await context.cookies('https://freelitecoin.online')).map(c => `${c.name}=${c.value.slice(0,20)}`).join(', '));
await context.close();