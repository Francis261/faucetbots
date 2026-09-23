import { chromium } from 'playwright';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE_URL = 'https://onlyfaucet.com';
const FAUCET_URL = `${BASE_URL}/faucet/currency/usdt`;
const PROFILE = join(process.env.HOME, '.onlyfaucet-chrome-profile');
const EMAIL = 'francisdominic261@gmail.com';
const OUT = '/tmp/onlyfaucet-probe';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${m}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  viewport: { width: 1280, height: 720 },
});
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = ctx.pages()[0] || (await ctx.newPage());
const cdp = await ctx.newCDPSession(page);

async function walkCDP(node, depth = 0, out = []) {
  if (!node) return out;
  const entry = {
    depth,
    nodeType: node.nodeType,
    nodeName: node.nodeName,
    nodeId: node.nodeId,
    backendNodeId: node.backendNodeId,
    id: node.attributes ? Object.fromEntries((node.attributes || []).reduce((a, v, i, arr) => (i % 2 === 0 ? a.push([v, arr[i + 1]]) : 0, a) && a, [])) : undefined,
    shadowRoots: (node.shadowRoots || []).map(s => ({ type: s.shadowRootType, nodeId: s.nodeId, childCount: s.childNodeCount })),
  };
  // simpler attrs
  if (node.attributes) {
    const attrs = {};
    for (let i = 0; i < node.attributes.length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
    entry.attrs = attrs;
    delete entry.id;
  }
  out.push(entry);
  if (node.children) for (const c of node.children) walkCDP(c, depth + 1, out);
  if (node.shadowRoots) for (const s of node.shadowRoots) {
    out.push({ depth: depth + 1, nodeType: '#shadow-root', nodeName: `#shadow(${s.shadowRootType})`, nodeId: s.nodeId, backendNodeId: s.backendNodeId });
    if (s.children) for (const c of s.children) walkCDP(c, depth + 2, out);
  }
  return out;
}

async function gotoRetry(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return true; }
    catch (e) {
      log(`goto ${url} attempt ${i + 1}: ${e.message.slice(0, 60)}`);
      await sleep(3000 + i * 2000);
    }
  }
  return false;
}

try {
  if (!(await gotoRetry(BASE_URL))) throw new Error('home nav failed');
  await sleep(4000);
  const loggedIn = await page.evaluate(() => /Logout|Dashboard/.test(document.body?.innerText || ''));
  if (!loggedIn) {
    await page.click('text=Login / Register').catch(() => {});
    await sleep(2000);
    await page.fill('#walletInput', EMAIL).catch(() => {});
    await sleep(500);
    await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
    await sleep(6000);
    log('Logged in');
  } else log('Already logged in');

  if (!(await gotoRetry(FAUCET_URL))) throw new Error('faucet nav failed');
  await sleep(5000);
  await page.screenshot({ path: `${OUT}/01-faucet.png`, fullPage: true });

  // Submit claim form if present
  const submitted = await page.evaluate(() => {
    const f = document.querySelector('form[action*="faucet/verify"]');
    if (f) { f.submit(); return true; }
    return false;
  });
  log(`Form submitted: ${submitted}`);
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/02-after-submit.png`, fullPage: true });

  // Click verification if needed
  for (let i = 0; i < 8; i++) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const cb = document.querySelector('[id^="cb_"]');
      let cbRect = null;
      if (cb) { const r = cb.getBoundingClientRect(); if (r.width > 0) cbRect = { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height }; }
      const h = document.querySelector('[id^="h_"]');
      let hRect = null;
      if (h) { const r = h.getBoundingClientRect(); hRect = { x: r.x, y: r.y, w: r.width, h: r.height }; }
      return {
        text: text.slice(0, 400),
        hasPuzzle: text.includes('Drag the shape'),
        hasVerif: text.includes('Verification Required'),
        cbRect, hRect,
        captcha_answer: document.querySelector('[name="captcha_answer"]')?.value || '',
        captcha_trace: document.querySelector('[name="captcha_trace"]')?.value || '',
      };
    });
    log(`[${i}] puzzle=${state.hasPuzzle} verif=${state.hasVerif} h=${JSON.stringify(state.hRect)} cb=${JSON.stringify(state.cbRect)} ans="${state.captcha_answer}"`);

    if (state.hasPuzzle && state.hRect && state.hRect.w > 50) break;

    if (state.cbRect) {
      await page.mouse.click(state.cbRect.x, state.cbRect.y);
      log('  clicked cb');
    }
    await sleep(3000);
  }

  await page.screenshot({ path: `${OUT}/03-puzzle.png`, fullPage: true });

  // CDP pierce DOM including closed shadow roots
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const flat = await walkCDP(root);
  writeFileSync(`${OUT}/cdp-dom.json`, JSON.stringify(flat.filter(n => {
    const s = JSON.stringify(n).toLowerCase();
    return /canvas|shadow|h_|cb_|captcha|iframe|puzzle|drag|verify|reset|button/.test(s) || n.nodeType === '#shadow-root';
  }), null, 2));
  writeFileSync(`${OUT}/cdp-dom-full.json`, JSON.stringify(flat, null, 2));
  log(`CDP nodes: ${flat.length}`);

  // Find all canvas nodes via CDP
  const canvasNodes = flat.filter(n => (n.nodeName || '').toUpperCase() === 'CANVAS');
  log(`Canvases via CDP: ${canvasNodes.length} ${JSON.stringify(canvasNodes.map(c => ({ nodeId: c.nodeId, backend: c.backendNodeId, attrs: c.attrs })))}`);

  // For each canvas, get box model and screenshot region
  for (const [idx, c] of canvasNodes.entries()) {
    try {
      const box = await cdp.send('DOM.getBoxModel', { backendNodeId: c.backendNodeId });
      const quad = box.model.border;
      const xs = quad.filter((_, i) => i % 2 === 0);
      const ys = quad.filter((_, i) => i % 2 === 1);
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      log(`Canvas ${idx} box: ${JSON.stringify(rect)} content=${JSON.stringify(box.model.content)}`);
      if (rect.w > 30 && rect.h > 30) {
        await page.screenshot({ path: `${OUT}/canvas-${idx}.png`, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } });
      }
    } catch (e) { log(`Canvas ${idx} box error: ${e.message}`); }
  }

  // Dump interesting JS globals / element props on h_ host
  const hostInfo = await page.evaluate(() => {
    const h = document.querySelector('[id^="h_"]');
    if (!h) return { found: false };
    const r = h.getBoundingClientRect();
    const keys = Object.keys(h);
    const props = {};
    for (const k of ['shadowRoot', 'canvas', 'answer', 'target', 'piece']) {
      try { props[k] = typeof h[k]; } catch {}
    }
    return { found: true, id: h.id, tag: h.tagName, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, keys: keys.slice(0, 50), props, html: h.outerHTML.slice(0, 500) };
  });
  writeFileSync(`${OUT}/host.json`, JSON.stringify(hostInfo, null, 2));
  log(`host: ${JSON.stringify(hostInfo.rect || hostInfo)}`);

  // Try Runtime to evaluate inside page and find answer-related vars
  try {
    const evalRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const out = {};
        out.h = !!document.querySelector('[id^="h_"]');
        out.forms = [...document.querySelectorAll('input[type=hidden]')].map(i => ({n:i.name, v:i.value})).filter(i => /captcha/i.test(i.n));
        // walk closed shadow via element internals not available; try all elements for assignedElements
        const all = [...document.querySelectorAll('*')];
        out.shadowHosts = all.filter(e => e.shadowRoot !== undefined).map(e => ({id: e.id, open: !!e.shadowRoot})).slice(0, 20);
        return JSON.stringify(out);
      })()`,
      returnByValue: true,
    });
    log(`Runtime: ${evalRes.result.value}`);
  } catch (e) { log(`Runtime error: ${e.message}`); }

  // Full page screenshot + h_ clip
  if (hostInfo.found && hostInfo.rect) {
    const { x, y, w, h } = hostInfo.rect;
    if (w > 20 && h > 20) {
      await page.screenshot({ path: `${OUT}/host-clip.png`, clip: { x: Math.max(0,x), y: Math.max(0,y), width: w, height: h } });
    }
  }
  await page.screenshot({ path: `${OUT}/04-final.png`, fullPage: true });

  // Dump body text snippet
  const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '');
  writeFileSync(`${OUT}/text.txt`, txt);
  log('text: ' + txt.replace(/\n/g, ' | ').slice(0, 300));
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  await page.screenshot({ path: `${OUT}/error.png`, fullPage: true }).catch(() => {});
}

await ctx.close().catch(() => {});
log('Done');
process.exit(0);
