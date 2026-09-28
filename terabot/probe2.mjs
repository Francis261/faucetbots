// probe2.mjs — click the Download button and observe: which endpoint fires,
// whether it redirects to a direct file URL or hits a login wall.  Also
// capture the /share/streaming m3u8 body (preview stream link).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2]
  || 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const OUT = new URL('./probe-out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();

const events = [];
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

page.on('request', (req) => {
  const u = req.url();
  if (/download|streaming|file|verify|login/i.test(u) && !/\.(js|css)(\?|$)/.test(u))
    events.push(`[${since()}] REQ ${req.method()} ${u.slice(0, 250)}`);
});
page.on('response', async (res) => {
  const u = res.url();
  const loc = res.headers()['location'];
  if (loc) events.push(`[${since()}] ${res.status()} REDIRECT -> ${loc.slice(0, 300)}`);
  if (/share\/streaming/i.test(u)) {
    const body = await res.text().catch(() => '');
    writeFileSync(`${OUT}/streaming.m3u8`, body);
    events.push(`[${since()}] streaming ${res.status()} (${body.length}B) url=${u.slice(0, 400)}`);
  }
  if (/download/i.test(u) && res.request().method() !== 'OPTIONS') {
    const body = await res.text().catch(() => '');
    events.push(`[${since()}] RESP ${res.status()} ${u.slice(0, 250)} body=${String(body).slice(0, 500)}`);
  }
});
page.on('popup', async (pop) => {
  events.push(`[${since()}] POPUP ${pop.url().slice(0, 250)}`);
  pop.on('response', async (res) => {
    if (/download|\.mp4|file/i.test(res.url())) {
      const loc = res.headers()['location'];
      events.push(`[${since()}] popup RESP ${res.status()} ${res.url().slice(0, 250)}${loc ? ` loc=${loc.slice(0, 250)}` : ''}`);
    }
  });
});
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) events.push(`[${since()}] NAV ${f.url().slice(0, 250)}`);
});
page.on('dialog', async (d) => { events.push(`[${since()}] DIALOG ${d.message().slice(0, 200)}`); await d.dismiss(); });

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(8000);

events.push(`[${since()}] --- clicking Download ---`);
const dl = page.locator('button:has-text("Download")').first();
console.log('Download button visible:', await dl.isVisible().catch(() => false));
await dl.click({ timeout: 10000 }).catch(e => events.push(`[${since()}] click failed: ${e.message.slice(0, 120)}`));
await page.waitForTimeout(12000);

const state = await page.evaluate(() => ({
  text: (document.body?.innerText || '').slice(0, 1500),
  url: location.href,
})).catch(() => ({}));
writeFileSync(`${OUT}/after-click.json`, JSON.stringify(state, null, 2));
await page.screenshot({ path: `${OUT}/after-click.png`, fullPage: true }).catch(() => {});

console.log(events.join('\n'));
console.log('--- final url:', state.url);
console.log('--- final text:', (state.text || '').slice(0, 600));
await browser.close();
