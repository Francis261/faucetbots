// probe_v5b.mjs — anatomy of the NEW v5 "creature" captcha on onlyfaucet.
// OBSERVE ONLY: may click the "Verification Required" entry checkbox (opens
// the widget) but NEVER taps a creature and NEVER presses Verify.
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
  if (!/captcha|verify|mcaptcha|creature/i.test(u)) return;
  const ct = res.headers()['content-type'] || '';
  let body = '';
  if (/json|text/.test(ct)) { try { body = (await res.text()); } catch {} }
  if (body) writeFileSync(`${SHOTS}/v5b-net-${Date.now()}.json`,
    `URL ${u}\nSTATUS ${res.status()}\n\n${body}`);
  net.push(`RES ${res.status()} ${u.slice(0, 200)} ct=${ct}` +
    (body ? `\n   ${body.slice(0, 600).replace(/\n/g, ' ')}` : ''));
});

const cfCleared = async () => {
  const t = await page.title().catch(() => '');
  if (!/Just a moment|Verifying/i.test(t)) {
    const b = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
    if (!/Performing security verification|Verify you are human/i.test(b)) return true;
  }
  return false;
};
const clickCfOnce = async () => {
  // same trick as bot.mjs clickChallengeBody: the CF widget is an iframe
  const pos = await page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].find((x) =>
      /cloudflare|turnstile|challenges/.test(x.src || ''));
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }).catch(() => null);
  if (pos) await page.mouse.click(pos.x + 25, pos.y + pos.h / 2);
  else await page.mouse.click(640, 450);
};

try {
  await page.goto(FAUCET, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  // CF gate: wait, click at most twice (bot-equivalent), never more
  let clicks = 0;
  for (let i = 0; i < 30 && !(await cfCleared()); i++) {
    if (i >= 4 && clicks < 2) { await clickCfOnce(); clicks++; }
    await sleep(2000);
  }
  console.log('CF cleared:', await cfCleared(), 'clicks:', clicks);
  await sleep(4000);

  // open the widget if it is not already (entry checkbox only — safe)
  const opened = await page.evaluate(() => {
    const hasWidget = /Tap every creature/i.test(document.body.innerText);
    if (hasWidget) return 'already-open';
    const el = [...document.querySelectorAll('button,div,label,a,span,input')]
      .find((e) => /Verification Required/i.test((e.innerText || e.value || '')));
    if (el) { el.click(); return 'clicked-entry: ' + el.tagName; }
    return 'entry-not-found';
  });
  console.log('open:', opened);
  await sleep(5000);

  const dump = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const R = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    // widget root: ancestor containing the instruction text
    let root = null;
    const hit = [...document.querySelectorAll('*')].find((e) =>
      vis(e) && /Tap every creature built like this one/i.test(e.innerText || '') &&
      e.children.length >= 2);
    if (hit) { root = hit; for (let i = 0; i < 6 && root.parentElement &&
      (root.innerText || '').length < 400; i++) root = root.parentElement; }
    const imgs = root ? [...root.querySelectorAll('img')].map((i) => ({
      src: i.src.startsWith('data:') ? `data:${i.src.slice(5, 40)}…(${i.src.length}B)` : i.src,
      nat: `${i.naturalWidth}x${i.naturalHeight}`, box: R(i), cls: i.className, id: i.id,
    })) : [];
    const buttons = root ? [...root.querySelectorAll('button,input[type=submit],[role=button]')]
      .map((b) => ({ tag: b.tagName, id: b.id, cls: String(b.className).slice(0, 60),
        text: (b.innerText || b.value || '').trim().slice(0, 30),
        disabled: b.disabled, box: R(b) })) : [];
    const canvas = root ? [...root.querySelectorAll('canvas')].map((c) => ({
      id: c.id, buf: `${c.width}x${c.height}`, box: R(c) })) : [];
    // inline handlers / listeners hints on the stage
    const stage = root ? (root.querySelector('[class*=stage],[class*=scene],[class*=grid],img[alt*=Captcha]') || null) : null;
    return {
      url: location.href,
      widgetRootHtml: root ? root.outerHTML.slice(0, 6000) : null,
      widgetBox: root ? R(root) : null,
      imgs, buttons, canvas,
      stage: stage ? { tag: stage.tagName, cls: String(stage.className), box: R(stage) } : null,
      bodyHasTutorial: /Tutorial/i.test(document.body.innerText),
    };
  });
  console.log('=== WIDGET DUMP ===');
  console.log(JSON.stringify(dump, null, 1));

  // page scripts that mention the captcha submit path
  const js = await page.evaluate(() => [...document.scripts]
    .map((s) => s.textContent || '')
    .filter((t) => /captcha|creature|zones|verify/i.test(t) && t.length > 100)
    .map((t) => {
      const m = t.match(/.{0,120}(fetch|axios|XMLHttpRequest|\/faucet\/\w+).{0,200}/g);
      return m ? m.slice(0, 6).join('\n---\n') : t.slice(0, 300);
    }).slice(0, 4));
  console.log('=== SCRIPT HINTS ===');
  console.log(js.join('\n=====\n'));

  await page.screenshot({ path: `${SHOTS}/v5b-widget.png`, fullPage: true }).catch(() => {});
  console.log('=== NET ===');
  console.log(net.join('\n') || '(no captcha/verify network seen yet)');
} finally {
  await ctx.close().catch(() => {});
}
