// probe_v5c.mjs — harvest the v5 captcha's JavaScript (scene/ref URLs,
// tap recording, verify submit payload) from the live page.
// OBSERVE ONLY: opens widget if needed; NEVER taps, NEVER verifies.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://onlyfaucet.com';
const FAUCET = `${BASE}/faucet/currency/usdt`;
const PROFILE = `${process.env.HOME}/.onlyfaucet-chrome-profile`;
const SHOTS = '/tmp/onlyfaucet-shots';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage', '--disable-gpu'],
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

const net = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!/captcha|creature|scene|verify|mcaptcha/i.test(u)) return;
  const ct = res.headers()['content-type'] || '';
  let body = '';
  if (/json|text|javascript/.test(ct)) { try { body = await res.text(); } catch {} }
  if (body) {
    const f = `${SHOTS}/v5c-${u.includes('scene') ? 'scene' : u.includes('verify') ? 'verify' : 'net'}-${Date.now()}.txt`;
    writeFileSync(f, `URL ${u}\nSTATUS ${res.status()} ct=${ct}\n\n${body}`);
    net.push(`${res.status()} ${u.slice(0, 180)} -> ${f}`);
  } else net.push(`${res.status()} ${u.slice(0, 180)} ct=${ct}`);
});

try {
  await page.goto(FAUCET, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) {
    const t = await page.title().catch(() => '');
    if (!/Just a moment|Verifying/i.test(t)) break;
    if (i === 4) {
      const pos = await page.evaluate(() => {
        const f = [...document.querySelectorAll('iframe')].find((x) => /cloudflare|turnstile|challenges/.test(x.src || ''));
        if (!f) return null; const r = f.getBoundingClientRect();
        return { x: r.x, y: r.y, h: r.height };
      });
      if (pos) await page.mouse.click(pos.x + 25, pos.y + pos.h / 2);
    }
    await sleep(2000);
  }
  await sleep(4000);

  // 1) save the raw HTML
  const html = await page.evaluate(async () => (await fetch(location.href)).text());
  writeFileSync(`${SHOTS}/v5c-page.html`, html);
  console.log('page html saved:', html.length, 'bytes');

  // 2) enumerate + fetch same-origin scripts, keep the interesting ones
  const srcs = await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map((s) => s.src)
      .filter((s) => s.includes('onlyfaucet.com')));
  console.log('scripts:', srcs.length);
  const interesting = [];
  for (const src of srcs) {
    if (!/captcha|creature|faucet|widget|main|app|custom/i.test(src)) continue;
    const body = await page.evaluate(async (u) => (await fetch(u)).text(), src)
      .catch(() => '');
    if (!body) continue;
    const name = src.split('/').pop().split('?')[0];
    writeFileSync(`${SHOTS}/v5c-js-${name}`, body);
    if (/SCENE_URL|creature|zones|captcha_answer|\/faucet\/verify/i.test(body)) interesting.push(src);
    console.log(`  ${src} (${body.length}B)`);
  }
  console.log('interesting:', interesting);

  // 3) inline scripts: those mentioning scene/verify/creature
  const inlines = await page.evaluate(() => [...document.scripts]
    .map((s) => s.textContent || '')
    .filter((t) => /SCENE_URL|REF_URL|creature|\/faucet\/verify|zones/i.test(t)));
  inlines.forEach((t, i) => writeFileSync(`${SHOTS}/v5c-inline-${i}.js`, t));
  console.log('inline scripts matched:', inlines.length,
    inlines.map((t) => t.length));

  // 4) captcha containers / selectCaptcha wiring
  const boxes = await page.evaluate(() => {
    const sc = document.querySelector('#selectCaptcha');
    return {
      selectCaptcha: sc ? { value: sc.value, options: [...sc.options].map((o) => o.value) } : null,
      captchaDivs: [...document.querySelectorAll('.captcha,[id*=captcha],[class*=captcha]')]
        .map((d) => ({ id: d.id, cls: String(d.className).slice(0, 50),
          display: getComputedStyle(d).display,
          text: (d.innerText || '').slice(0, 80).replace(/\n/g, '|') })),
      iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || 'inline').slice(0, 100)),
    };
  });
  console.log('=== captcha wiring ===');
  console.log(JSON.stringify(boxes, null, 1));

  // 5) open widget (trusted click path: find element, use Playwright click)
  const entry = page.locator('text=/Verification Required/i').first();
  if (await entry.count()) {
    await entry.click({ timeout: 4000 }).catch((e) => console.log('entry click:', e.message.slice(0, 80)));
    await sleep(6000);
  }
  const widget = await page.evaluate(() => ({
    body: document.body.innerText.slice(0, 600),
    hasCreatureText: /Tap every creature/i.test(document.body.innerText),
    imgs: [...document.images].map((i) => ({
      src: i.src.startsWith('data:') ? `data:${i.naturalWidth}x${i.naturalHeight} (${i.src.length}B)` : i.src.slice(0, 140),
      box: (() => { const r = i.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })(),
    })),
  }));
  console.log('=== after entry click ===');
  console.log(JSON.stringify(widget, null, 1));
  await page.screenshot({ path: `${SHOTS}/v5c-widget.png`, fullPage: true }).catch(() => {});
  console.log('=== NET ===');
  console.log(net.join('\n') || '(nothing)');
} finally {
  await ctx.close().catch(() => {});
}
