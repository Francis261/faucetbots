// probe_v5.mjs — recon the NEW captcha (v5 "tap the creatures") on onlyfaucet.
// OBSERVE ONLY: no widget taps, no drags, no Verify submissions.
// Dumps page state + captcha-related network traffic + a full screenshot.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'https://onlyfaucet.com';
const FAUCET = `${BASE}/faucet/currency/usdt`;
const PROFILE = `${process.env.HOME}/.onlyfaucet-chrome-profile`;
const SHOTS = '/tmp/onlyfaucet-shots';
mkdirSync(SHOTS, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage', '--disable-gpu'],
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

const net = [];
const keep = (u) => /captcha|mcaptcha|verify|challenge|creature/i.test(u) ||
  /faucet\/(?!currency)/.test(u);
page.on('request', (r) => {
  const u = r.url();
  if (keep(u) && !/\.(css|woff2?|png|jpe?g|gif|svg)(\?|$)/.test(u)) {
    net.push(`REQ ${r.method()} ${u.slice(0, 220)}` +
      (r.postData() ? `\n     body=${r.postData().slice(0, 400)}` : ''));
  }
});
page.on('response', async (res) => {
  const u = res.url();
  if (!keep(u)) return;
  const h = res.headers();
  let body = '';
  const ct = h['content-type'] || '';
  if (/json|text/.test(ct)) { try { body = (await res.text()).slice(0, 500); } catch {} }
  net.push(`RES ${res.status()} ${u.slice(0, 220)} ct=${ct}` +
    (h['x-captcha-piece'] ? ` x-captcha-piece=${h['x-captcha-piece']}` : '') +
    (body ? `\n     body=${body.replace(/\n/g, ' ').slice(0, 450)}` : ''));
});

try {
  await page.goto(FAUCET, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(10000);

  const dump = async (tag) => page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const R = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    // captcha-ish elements by id/class/name
    const els = [...document.querySelectorAll('*')].filter((el) =>
      /captcha|creature|verify|puzzle|challenge/i.test(`${el.id} ${el.className} ${el.getAttribute?.('name') || ''}`))
      .filter(vis).slice(0, 50)
      .map((el) => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 70), box: R(el) }));
    const imgs = [...document.images].filter(vis).slice(0, 30).map((i) => ({
      src: i.src.startsWith('data:') ? `data: ${i.naturalWidth}x${i.naturalHeight}` : i.src.slice(0, 140),
      nat: `${i.naturalWidth}x${i.naturalHeight}`, box: R(i),
    }));
    const canv = [...document.querySelectorAll('canvas')].map((c) => ({
      id: c.id, buf: `${c.width}x${c.height}`, box: R(c),
    }));
    const forms = [...document.forms].map((f) => ({ action: f.action.slice(0, 140), id: f.id }));
    const scripts = [...document.scripts].map((s) => s.src).filter(Boolean)
      .filter((s) => /captcha|mcaptcha|widget|faucet/i.test(s)).slice(0, 10);
    const iframes = [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 120));
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body.innerText || '').slice(0, 1500),
      els, imgs, canv, forms, scripts, iframes,
    };
  });

  const d1 = await dump();
  console.log('=== STATE after 10s ===');
  console.log(JSON.stringify(d1, null, 1));
  await page.screenshot({ path: `${SHOTS}/v5-recon1.png`, fullPage: true }).catch(() => {});

  // if a CF gate is up, give it a chance to self-clear (never click more than
  // the single routine widget click the bot itself does)
  const body1 = d1.bodyText || '';
  if (/Verifying|verify you are human|Just a moment/i.test(body1)) {
    console.log('=== CF gate visible — waiting 20s (no clicks) ===');
    await page.waitForTimeout(20000);
    const d2 = await dump();
    console.log(JSON.stringify({ url: d2.url, bodyText: d2.bodyText.slice(0, 900) }, null, 1));
    await page.screenshot({ path: `${SHOTS}/v5-recon2.png`, fullPage: true }).catch(() => {});
  }
} finally {
  console.log('=== NETWORK ===');
  console.log(net.join('\n') || '(nothing captcha-related)');
  await ctx.close().catch(() => {});
}
