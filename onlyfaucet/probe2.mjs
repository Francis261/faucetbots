import { chromium } from 'playwright';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE_URL = 'https://onlyfaucet.com';
const FAUCET_URL = `${BASE_URL}/faucet/currency/usdt`;
const PROFILE = join(process.env.HOME, '.onlyfaucet-chrome-profile');
const EMAIL = 'francisdominic261@gmail.com';
const OUT = '/tmp/onlyfaucet-cdp';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${m}`);

async function gotoRetry(page, url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return true; }
    catch (e) { log(`goto: ${e.message.slice(0, 50)}`); await sleep(3000 + i * 2000); }
  }
  return false;
}

function walk(node, depth, out) {
  if (!node) return;
  const attrs = {};
  if (node.attributes) for (let i = 0; i < node.attributes.length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
  out.push({
    d: depth, name: node.nodeName, id: node.nodeId, backend: node.backendNodeId,
    attrs: Object.keys(attrs).length ? attrs : undefined,
    shadow: (node.shadowRoots || []).map(s => ({ type: s.shadowRootType, id: s.nodeId, kids: s.childNodeCount })),
    value: node.nodeValue ? String(node.nodeValue).slice(0, 200) : undefined,
  });
  if (node.children) for (const c of node.children) walk(c, depth + 1, out);
  if (node.shadowRoots) for (const s of node.shadowRoots) {
    out.push({ d: depth + 1, name: `#shadow-${s.shadowRootType}`, id: s.nodeId, backend: s.backendNodeId });
    if (s.children) for (const c of s.children) walk(c, depth + 2, out);
  }
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  viewport: { width: 1280, height: 800 },
});
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = ctx.pages()[0] || (await ctx.newPage());
const cdp = await ctx.newCDPSession(page);

try {
  if (!(await gotoRetry(page, BASE_URL))) throw new Error('nav fail');
  await sleep(3000);
  const loggedIn = await page.evaluate(() => /Logout|Dashboard|Claim Now/.test(document.body?.innerText || ''));
  if (!loggedIn) {
    await page.click('text=Login / Register').catch(() => {});
    await sleep(2000);
    await page.fill('#walletInput', EMAIL).catch(() => {});
    await sleep(500);
    await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
    await sleep(6000);
  }
  if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav fail');
  await sleep(4000);

  // Submit claim to trigger captcha
  await page.evaluate(() => {
    const f = document.querySelector('form[action*="faucet/verify"]');
    if (f) f.submit();
  }).catch(() => {});
  await sleep(8000);

  // Dismiss error, click verification
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
  for (let i = 0; i < 10; i++) {
    const st = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const cb = document.querySelector('[id^="cb_"]');
      let r = null;
      if (cb) { const b = cb.getBoundingClientRect(); if (b.width > 0) r = { x: b.x + b.width/2, y: b.y + b.height/2 }; }
      return { puzzle: t.includes('Drag the shape'), verif: t.includes('Verification Required'), r, snip: t.slice(0, 200) };
    }).catch(() => ({ puzzle: false, verif: false, r: null, snip: '' }));
    log(`[${i}] puzzle=${st.puzzle} verif=${st.verif}`);
    if (st.puzzle) break;
    if (st.r) { await page.mouse.click(st.r.x, st.r.y); log('clicked cb'); }
    await sleep(2500);
  }

  await page.screenshot({ path: `${OUT}/puzzle.png`, fullPage: true });

  // CDP pierce
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const flat = [];
  walk(root, 0, flat);
  writeFileSync(`${OUT}/cdp.json`, JSON.stringify(flat, null, 2));
  log(`nodes=${flat.length}`);
  const shadows = flat.filter(n => n.name?.startsWith('#shadow'));
  log(`shadows=${JSON.stringify(shadows)}`);
  const canvases = flat.filter(n => n.name === 'CANVAS');
  log(`canvases=${JSON.stringify(canvases)}`);

  // Box models for canvases / interesting nodes
  for (const n of [...canvases, ...flat.filter(x => /HOST|DIV|SECTION/.test(x.name) && x.shadow?.length)]) {
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backend });
      const q = model.border;
      const xs = q.filter((_, i) => i % 2 === 0), ys = q.filter((_, i) => i % 2 === 1);
      log(`box ${n.name}#${n.id}: ${JSON.stringify({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys) })}`);
    } catch (e) { log(`box ${n.name}: ${e.message.slice(0, 60)}`); }
  }

  // Try Runtime to inspect window for captcha-related state
  const evals = [
    `Object.keys(window).filter(k => /captcha|puzzle|drag|answer|target|widget|verify/i.test(k)).join(',')`,
    `JSON.stringify((window.__CAPTCHA_STATE__ || window.captchaState || window.puzzle || null))`,
    `[...document.querySelectorAll('*')].filter(e => e.shadowRoot).map(e => e.id || e.tagName).join(',')`,
    // Element with id h_
    `(() => { const h = document.querySelector('[id^="h_"]'); return h ? JSON.stringify({id: h.id, keys: Object.keys(h), html: h.outerHTML.slice(0,300)}) : 'none'; })()`,
    // Try attachShadow hook detection
    `(() => { let found = null; const orig = Element.prototype.attachShadow; const all = document.querySelectorAll('[id^="h_"]'); return all.length + ' hosts'; })()`,
  ];
  for (const expr of evals) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      log(`eval: ${String(r.result.value).slice(0, 300)}`);
    } catch (e) { log(`eval err: ${e.message.slice(0, 80)}`); }
  }

  // Screenshot h_ region
  const hInfo = await page.evaluate(() => {
    const h = document.querySelector('[id^="h_"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (hInfo && hInfo.w > 50) {
    await page.screenshot({ path: `${OUT}/h-clip.png`, clip: { x: hInfo.x, y: hInfo.y, width: hInfo.w, height: hInfo.h } });
    log(`h clip: ${JSON.stringify(hInfo)}`);
  }
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
}

await ctx.close().catch(() => {});
log('Done');
process.exit(0);
