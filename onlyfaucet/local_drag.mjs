// OFFLINE rehearsal of the puzzle DRAG — no contact with onlyfaucet.com, so
// no CAPTCHA attempt can ever be burned.
//
// It loads the dumped live page (page-dump.html, widget markup + inline
// script intact), stubs window.fetch for the widget's captcha_image request
// with a captured challenge (bg PNG + X-Captcha-Piece header), clicks the
// checkbox like a user would, and then runs the REAL production dragCanvas()
// from bot.mjs.  Afterwards it reports exactly what the widget recorded:
//   ca_  = captcha_answer ("px,py" drop position, canvas coords)
//   pt_  = pointer type, written ONLY when pointerdown passed the widget's
//          grab test (within pieceR*1.15 of the piece) — a free bisect signal
//   __ptr = document-level pointerdown/up trace (did the press reach us?)
//
// Usage: DISPLAY=:0 node local_drag.mjs
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { log, sleep, getCanvasTransform, canvasToPage, dragCanvas, SHOT_DIR } from './bot.mjs';

const BG = `${SHOT_DIR}/bg-1790437424889.png`;     // verify6 challenge bg (450x280)
const SPRITE = `${SHOT_DIR}/sprite-1790437422807.png`; // its piece sprite (116x116)
const PAGE = `${SHOT_DIR}/page-dump.html`;          // full live page dump
const PIECE = { x: 59, y: 80 };                     // X-Captcha-Piece from that challenge
const TARGET = { x: 81, y: 211 };                   // verify6 chain verdict (chain-clear)

const bgB64 = readFileSync(BG).toString('base64');
const sprB64 = readFileSync(SPRITE).toString('base64');
const hdr = Buffer.from(JSON.stringify({ x: PIECE.x, y: PIECE.y, sprite: sprB64 })).toString('base64');

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage', '--disable-gpu'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  await ctx.addInitScript(({ b64, header }) => {
    // Serve the widget's captcha_image request from our captured challenge.
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const u = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (u.includes('captcha_image')) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return Promise.resolve(new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'X-Captcha-Piece': header },
        }));
      }
      return orig(input, init);
    };
    // The dump was serialized with the widget OPEN (inline styles: checkbox
    // hidden, challenge visible).  Restore the server's initial state so the
    // flow starts at the checkbox, like on the live page.
    document.addEventListener('DOMContentLoaded', () => {
      const first = (p) => document.querySelector(p);
      const cb = first('[id^="cb_"]:not([id^="cb_btn_"])');
      const ch = first('[id^="ch_"]');
      const rb = first('[id^="rb_btn_"]');
      const cw = first('[id^="cw_"]');
      const ca = first('[id^="ca_"]');
      if (cb) cb.style.display = 'flex';
      if (ch) ch.style.display = 'none';
      if (rb) rb.style.display = 'none';
      if (cw) cw.style.display = 'none';
      if (ca) ca.value = '';
      // pointer trace: canvas sits in a CLOSED shadow root, but events
      // retarget to the host at document level, and clientX/Y survive.
      window.__ptr = [];
      const rec = (e) => window.__ptr.push({
        t: e.type, x: Math.round(e.clientX), y: Math.round(e.clientY),
        trusted: e.isTrusted, tgt: (e.target && (e.target.id || e.target.tagName)) || null,
      });
      for (const t of ['pointerdown', 'pointerup', 'pointercancel']) {
        document.addEventListener(t, rec, true);
      }
    });
  }, { b64: bgB64, header: hdr });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`pageerror: ${String(e.message).slice(0, 140)}`));
  // The dump is a full live page: its ad/analytics scripts rewrite the DOM and
  // intermittently destroy the widget (observed locally).  Drag robustness
  // against live ads is handled inside dragCanvas itself (hit-test + re-measure
  // + grab-check), so here we only need a deterministic page: block external
  // JS, keep styles/images (the widget is inline markup + inline script).
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('file:')) return route.continue();
    if (route.request().resourceType() === 'script') return route.abort();
    return route.continue();
  });
  await page.goto('file://' + PAGE, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // --- click the checkbox (trusted mouse event; .click() would forceFail) ---
  const cbBox = await page.evaluate(() => {
    const el = document.querySelector('[id^="cb_"]:not([id^="cb_btn_"])');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, display: getComputedStyle(el).display };
  });
  if (!cbBox || cbBox.w < 10) throw new Error(`checkbox not visible: ${JSON.stringify(cbBox)}`);
  log(`checkbox box=${JSON.stringify(cbBox)}`);
  await sleep(300);
  // locator click: Playwright hit-tests and waits out transient overlays
  try {
    await page.locator('[id^="cb_"]:not([id^="cb_btn_"])').click({ timeout: 6000 });
  } catch (e) {
    log(`locator click failed: ${String(e.message).slice(0, 120)} — raw mouse fallback`);
    const cb2 = await page.evaluate(() => {
      const el = document.querySelector('[id^="cb_"]:not([id^="cb_btn_"])');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!cb2 || cb2.w < 10) throw new Error('checkbox vanished');
    await page.mouse.click(cb2.x + cb2.w / 2, cb2.y + cb2.h / 2);
  }

  // --- wait for the challenge to be shown (cb hidden, ch visible) ----------
  let open = false;
  for (let i = 0; i < 30; i++) {
    const st = await page.evaluate(() => {
      const ch = document.querySelector('[id^="ch_"]');
      const h = document.querySelector('[id^="h_"]');
      const cb = document.querySelector('[id^="cb_"]:not([id^="cb_btn_"])');
      if (!ch || !h) return null;
      const r = h.getBoundingClientRect();
      return {
        chVis: getComputedStyle(ch).display !== 'none',
        cbVis: cb ? getComputedStyle(cb).display !== 'none' : false,
        host: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    });
    if (i % 5 === 0) log(`poll${i}: ${JSON.stringify(st)}`);
    if (st && st.chVis && !st.cbVis && st.host[2] > 80) { log(`challenge open ${JSON.stringify(st)}`); open = true; break; }
    await sleep(400);
  }
  if (!open) throw new Error('widget never opened locally');

  // --- probe: what is on top of the press point? ---------------------------
  const tr = await getCanvasTransform(page);
  if (!tr) throw new Error('no canvas transform');
  log(`transform canvasX=${tr.canvasX.toFixed(1)} canvasY=${tr.canvasY.toFixed(1)} canvasW=${tr.canvasW.toFixed(1)} canvasH=${tr.canvasH.toFixed(1)}`);
  const f = canvasToPage(tr, PIECE.x, PIECE.y);
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const stack = document.elementsFromPoint(x, y).map(e => (e.id || e.tagName) + (e.tagName === 'IFRAME' ? ':' + (e.src || '').slice(0, 40) : ''));
    return { at: [Math.round(x), Math.round(y)], top: el ? (el.id || el.tagName) : null, stack: stack.slice(0, 6) };
  }, [f.x, f.y]);
  log(`press target: ${JSON.stringify(hit)}`);

  // --- the REAL production drag -------------------------------------------
  const t0 = Date.now();
  await dragCanvas(page, tr, PIECE, TARGET);
  const leg1ms = Date.now() - t0;

  const readFields = () => page.evaluate(() => {
    const val = (p) => { const el = document.querySelector(p); return el ? el.value : null; };
    return {
      ca: val('[id^="ca_w_"]'), pt: val('[id^="pt_w_"]'),
      tr: (val('[id^="tr_w_"]') || '').slice(0, 160),
      ptr: window.__ptr || [],
    };
  });
  const parse = (v) => v && /^\d+,\d+$/.test(v) ? v.split(',').map(Number) : null;
  const driftOf = (v) => { const p = parse(v); return p ? Math.round(Math.hypot(p[0] - TARGET.x, p[1] - TARGET.y) * 10) / 10 : null; };

  const leg1 = await readFields();
  log(`leg1 (piece->target): ca_="${leg1.ca}" pt_="${leg1.pt}" drift=${driftOf(leg1.ca)} dragMs=${leg1ms}`);

  // Leg 2+3: the recovery path the bot uses when a drop lands far off —
  // grab the piece WHERE IT LANDED and nudge it onto the target.  This also
  // exercises the second-drag grab check (pt_ already set from leg 1).
  const legs = [{ leg: 1, answer: leg1.ca, driftPx: driftOf(leg1.ca), grabPassed: !!leg1.pt, dragMs: leg1ms }];
  const cur = parse(leg1.ca);
  if (cur) {
    const BAD = { x: TARGET.x + 25, y: TARGET.y - 10 };
    const t2 = Date.now();
    await dragCanvas(page, tr, { x: cur[0], y: cur[1] }, BAD);
    const leg2ms = Date.now() - t2;
    const leg2 = await readFields();
    log(`leg2 (deliberate bad drop): ca_="${leg2.ca}" drift=${driftOf(leg2.ca)} dragMs=${leg2ms}`);
    legs.push({ leg: 2, answer: leg2.ca, driftPx: driftOf(leg2.ca), dragMs: leg2ms });
    const cur2 = parse(leg2.ca);
    if (cur2) {
      const t3 = Date.now();
      await dragCanvas(page, tr, { x: cur2[0], y: cur2[1] }, TARGET);
      const leg3ms = Date.now() - t3;
      const leg3 = await readFields();
      log(`leg3 (nudge back to target): ca_="${leg3.ca}" drift=${driftOf(leg3.ca)} dragMs=${leg3ms}`);
      legs.push({ leg: 3, answer: leg3.ca, driftPx: driftOf(leg3.ca), dragMs: leg3ms });
    }
  }
  const last = legs[legs.length - 1];
  const finalPtr = await page.evaluate(() => window.__ptr || []).catch(() => []);
  log(`pointer events: ${JSON.stringify(finalPtr)}`);
  console.log('LOCAL_DRAG ' + JSON.stringify({
    legs,
    final: last,
    ok: last && last.driftPx != null && last.driftPx <= 6,
    pressTop: hit.top,
  }));
} finally {
  await browser.close().catch(() => {});
}
