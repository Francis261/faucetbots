// probe_v6.mjs — identify the live captcha version (v5 vs v6): waits out the
// Cloudflare interstitial, opens the widget with one trusted gate click,
// then dumps card text, tutorial link (mc-tut href), images and the
// captcha_image payload geometry. NEVER taps creatures, NEVER verifies.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://onlyfaucet.com';
const FAUCET = `${BASE}/faucet/currency/usdt`;
const PROFILE = `${process.env.HOME}/.onlyfaucet-chrome-profile`;
const SHOTS = '/tmp/onlyfaucet-shots';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = `v6probe-${Date.now()}`;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage', '--disable-gpu'],
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

let payload = null;
page.on('response', async (res) => {
  if (!res.url().includes('/faucet/captcha_image')) return;
  try {
    const hdr = res.headers()['x-captcha-piece'];
    const txt = hdr ? '(legacy piece header)' : await res.text();
    let info = { url: res.url(), status: res.status(), hdr: !!hdr };
    if (!hdr) {
      try {
        const j = JSON.parse(txt);
        const dims = (d) => { try { const b = Buffer.from(String(d).split(',')[1], 'base64'); return `${b.length}B`; } catch { return '?'; } };
        info.keys = Object.keys(j);
        info.scene = dims(j.scene);
        info.ref = dims(j.ref);
        if (j.scene) writeFileSync(`${SHOTS}/${TAG}-scene.b64`, j.scene);
        if (j.ref) writeFileSync(`${SHOTS}/${TAG}-ref.b64`, j.ref);
      } catch (e) { info.parseErr = e.message; info.head = String(txt).slice(0, 120); }
    }
    payload = info;
    console.log('captcha_image payload:', JSON.stringify(info));
  } catch (e) { console.log('payload err:', e.message); }
});

try {
  await page.goto(FAUCET, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  // Cloudflare: wait it out; click the turnstile checkbox if it appears
  let clicked = 0;
  for (let i = 0; i < 45; i++) {
    const st = await page.evaluate(() => ({
      body: document.body.innerText.slice(0, 200),
      title: document.title,
      turnstile: (() => {
        const f = [...document.querySelectorAll('iframe')]
          .find(x => /challenges|turnstile|cloudflare/i.test((x.src || '') + (x.title || '')));
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return r.width > 0 ? { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 } : null;
      })(),
    })).catch(() => null);
    if (!st) { await sleep(2000); continue; }
    const blocked = /security verification|Just a moment|Verifying/i.test(st.body + st.title);
    if (!blocked) { console.log(`CF cleared after ~${i * 2}s`); break; }
    if (st.turnstile && clicked < 2 && i % 8 === 6) {
      await page.mouse.click(st.turnstile.x, st.turnstile.y).catch(() => {});
      clicked++;
      console.log('clicked turnstile');
    }
    // Interactive Turnstile renders inside a shadow root (invisible to
    // querySelectorAll('iframe')) — click the checkbox position directly,
    // same fallback the bot uses. Visible box: ~193-493 x, ~305-365 y.
    if (!st.turnstile && clicked < 3 && (i === 8 || i === 20)) {
      await page.mouse.click(211, 336).catch(() => {});
      clicked++;
      console.log(`clicked turnstile checkbox coords (i=${i})`);
    }
    await sleep(2000);
  }
  await sleep(3000);

  const pageinfo = await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 900),
    tut: (() => { const a = document.querySelector('a.mc-tut, a[href*="mcaptcha"]'); return a ? a.getAttribute('href') : null; })(),
    gate: (() => { const g = document.querySelector('.mc-gate'); return g ? { hidden: g.hidden, text: (g.innerText || '').slice(0, 120) } : null; })(),
  }));
  console.log('=== page ===');
  console.log(JSON.stringify(pageinfo, null, 1));
  writeFileSync(`${SHOTS}/${TAG}-page.html`, await page.evaluate(async () => (await fetch(location.href)).text()).catch(() => ''));

  // one trusted gate click (fires captcha_image)
  const entry = page.locator('text=/Verification Required/i').first();
  if (await entry.count()) {
    await entry.click({ timeout: 4000 }).catch((e) => console.log('entry click:', e.message.slice(0, 80)));
    console.log('gate clicked; waiting for card...');
  } else {
    console.log('no Verification Required entry visible');
  }
  for (let i = 0; i < 10 && !payload; i++) await sleep(1000);
  await sleep(4000);

  const widget = await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 900),
    tut: (() => { const a = document.querySelector('a.mc-tut, a[href*="mcaptcha"]'); return a ? a.getAttribute('href') : null; })(),
    everyCreature: /Tap every creature/i.test(document.body.innerText),
    twins: /Find its twins/i.test(document.body.innerText),
    imgs: [...document.images].map(i => ({
      src: i.src.startsWith('data:') ? `data:${i.naturalWidth}x${i.naturalHeight}` : i.src.slice(0, 120),
      box: (() => { const r = i.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })(),
    })),
  }));
  console.log('=== widget ===');
  console.log(JSON.stringify(widget, null, 1));
  await page.screenshot({ path: `${SHOTS}/${TAG}-widget.png`, fullPage: true }).catch(() => {});
  console.log('screenshot:', `${SHOTS}/${TAG}-widget.png`);
} finally {
  await ctx.close().catch(() => {});
}
