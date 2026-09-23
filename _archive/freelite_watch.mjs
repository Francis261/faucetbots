import { chromium } from 'playwright';

const EMAIL = 'francisdominic261@gmail.com';
const PROFILE = '/home/francis/.config/google-chrome';

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport: null,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

page.on('requestfailed', r => {
  if (r.url().includes('challenges.cloudflare.com')) console.log('  [reqfail]', r.url().slice(0, 90), r.failure()?.errorText);
});

await page.goto('https://freelitecoin.online/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.fill('input[name="faucet_email"]', EMAIL).catch(() => {});

let ts;
for (let i = 0; i < 15 && !ts; i++) { ts = page.frames().find(f => f.url().includes('turnstile')); if (!ts) await page.waitForTimeout(1000); }
console.log('ts frame:', !!ts, ts?.url().slice(0, 100));

for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(2000);
  const info = ts ? await ts.evaluate(() => {
    // traverse shadow roots to find visible elements
    const out = [];
    const walk = (node, depth) => {
      if (!node || depth > 4) return;
      const sr = node.shadowRoot;
      if (sr) sr.querySelectorAll('*').forEach(c => walk(c, depth + 1));
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0 };
      if (node.tagName && r.width > 4 && r.height > 4) {
        out.push({ tag: node.tagName.toLowerCase(), cls: (node.className || '').slice(0, 40), role: node.getAttribute?.('role') || '' });
      }
      if (node.children) for (const c of node.children) walk(c, depth + 1);
    };
    walk(document.body, 0);
    return {
      title: document.title,
      htmlLen: document.body?.innerHTML?.length || 0,
      vis: out.slice(0, 15),
      hasCheckbox: !!document.querySelector('input[type=checkbox], [id*=checkbox], .rc-checkbox, [class*=checkbox]'),
    };
  }).catch(e => ({ err: e.message.slice(0, 60) })) : {};
  const token = (await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '')).length;
  const tag = `[${String(i).padStart(2)}] title="${info.title}" htmlLen=${info.htmlLen} chk=${info.hasCheckbox} token=${token} vis=${JSON.stringify((info.vis||[]).slice(0,3))}`;
  console.log(tag);
  if (token > 20 || info.hasCheckbox) { console.log('== CAPTCHA INTERACTIVE/TICKED =='); }
  if (token > 20) break;
}

await context.close();