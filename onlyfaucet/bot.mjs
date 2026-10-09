import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE_URL = 'https://onlyfaucet.com';
const FAUCET_URL = `${BASE_URL}/faucet/currency/usdt`;
const PROFILE = join(process.env.HOME, '.onlyfaucet-chrome-profile');
const LOCKFILE = '/tmp/onlyfaucet.lock';
const ACCOUNTS_FILE = join(import.meta.dirname, 'accounts.json');
const SHOT_DIR = '/tmp/onlyfaucet-shots';

const VISION_HOST = 'https://ollama.com';
const VISION_KEY = 'b3be06fa11184ba2a874259bb0b505f7.6v336cULw7DZ8EMHdPq6OPlc';
const VISION_MODEL = 'gemma4:31b';

function log(msg) { console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// The widget force-fails itself 50s after it appears (answer='-1,-1', form
// submit) — that counts as a failed CAPTCHA attempt, and 3 of those = ban.
// Track when the current widget appeared so we can always bail out in time.
const FORCE_FAIL_MS = 50000;
const BAIL_MS = 43000;          // 7s of headroom for reload + Cloudflare
const widgetClock = { shownAt: 0 };

function markWidgetShown() { if (!widgetClock.shownAt) { widgetClock.shownAt = Date.now(); noteRoundStart(); } }
function widgetAgeMs() { return widgetClock.shownAt ? Date.now() - widgetClock.shownAt : 0; }
function pastBailWindow() { return widgetClock.shownAt > 0 && widgetAgeMs() > BAIL_MS; }
function clearWidgetClock() { widgetClock.shownAt = 0; }

// ---- Round spacing (open-rate protection) --------------------------------
// The site issues a 1h block, lazily on the next page load, once >=3 "round
// events" land within ~7 minutes, where an event is EITHER a checkbox start
// OR a mid-widget bail reload (observed: 2 abandoned rounds = 4 events in
// 104s => 1h block; separately, 3 plain opens in ~7min => 1h block).  The
// state is PERSISTED because fresh `once` processes must respect it too —
// two manual runs 86s apart are exactly how the last block happened — and
// because the server keeps its own count across restarts.
const ROUND_SPACING_FILE = join(import.meta.dirname, '.round-state.json');
const ROUND_SPACING_MS = 7 * 60 * 1000;
const roundState = (() => {
  try {
    const s = JSON.parse(readFileSync(ROUND_SPACING_FILE, 'utf8'));
    if (s && Number.isFinite(s.lastStart)) return s;
  } catch {}
  return { lastStart: 0 };
})();
function noteRoundStart() {
  roundState.lastStart = Date.now();
  try { writeFileSync(ROUND_SPACING_FILE, JSON.stringify(roundState)); } catch {}
}
function roundSpacingLeft() {
  return Math.max(0, roundState.lastStart + ROUND_SPACING_MS - Date.now());
}
// A BAIL costs a round event of its own (the mid-widget reload), so an open
// that follows a bail must still wait out the 7min event floor — two
// abandoned rounds = 4 events in 104s drew a 1h block.  A CLEAN round costs
// only its single checkbox start, so when the widget is already sitting on
// screen the bot clicks it instead of idling: an unclicked visible widget
// stalls every claim while spending zero events (the old fixed 420-900s
// abort ladder froze the loop for 18min with the widget up).  Persisted in
// the round state so fresh processes honour it too.
function markBail() {
  roundState.bailAt = Date.now();
  recoveryPermit.used = true;   // a fresh bail revokes any unused permit
  try { writeFileSync(ROUND_SPACING_FILE, JSON.stringify(roundState)); } catch {}
}
function bailFresh() {
  return Number.isFinite(roundState.bailAt) && Date.now() - roundState.bailAt < ROUND_SPACING_MS;
}
// ONE-SHOT recovery engage permit (user decision 2026-10-09): after an
// error reload + relogin with a captcha still pending, open it IMMEDIATELY
// instead of waiting out the 7-min floor — exactly once per recovery.
// Safety caps: consumed on first use, expires after 120s, and any new
// markBail() revokes an unused permit — so a failing retry cannot loop
// (the fail ladder still pauses at 2/2; the floor governs everything after
// the single engage).
const recoveryPermit = { at: 0, used: false };
function noteRecoveryDone() {
  if (!bailFresh()) return;   // floor not active — gates are already open
  recoveryPermit.at = Date.now();
  recoveryPermit.used = false;
}
function consumeRecoveryPermit() {
  if (recoveryPermit.used) return false;
  if (!recoveryPermit.at || Date.now() - recoveryPermit.at > 120000) return false;
  recoveryPermit.used = true;
  log('Recovery permit: opening the pending captcha immediately (one-shot; floor resumes if this round does not verify)');
  return true;
}

// Abandon the current puzzle WITHOUT submitting: reloading before the 50s
// mark means no attempt is recorded (forceFail only fires while the page lives).
// `ret` lets a caller bail safely AND still report a real failure (e.g. the
// site already recorded a rejected attempt).
async function bailOutOfPuzzle(page, reason, ret = 'aborted') {
  log(`BAILOUT (${reason}) after ${widgetAgeMs()}ms — reloading before forceFail, no attempt recorded (returns ${ret})`);
  clearWidgetClock();
  markBail(); // reload = a round event: next open owes the 7min floor
  try { await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
  await sleep(3000);
  await ensureCleared(page);
  return ret;
}

// One Verify per claimFaucet() call. A rejected Verify is a real attempt and
// the site hands back a brand-new puzzle immediately, so an auto-retry inside
// the same call is exactly how you get from 1 failure to a 3-strike ban.
// runLoop gates the next call on the captcha-failure ladder instead.
const submitGuard = { used: false };
// Dry-run (CLI `dryv5`): drive the full production v5 path — gate click,
// payload capture, solve, taps, ca_ closed-loop check — then STOP before
// Verify.  Never set outside runDryV5.
let dryRunMode = false;

function parseJSON(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (match) {
    try { return JSON.parse(match[1].trim()); } catch {}
  }
  try { return JSON.parse(text.trim()); } catch { return null; }
}

async function analyzePuzzle(imageBuf, width, height) {
  const base64 = imageBuf.toString('base64');
  // Avoid refusal-triggering words (captcha/security/bypass). Pure perception task.
  const prompt = `You are given a pattern image of size ${width}x${height} pixels.
It contains exactly two notable regions:
1) A closed shape drawn with a bright blue/cyan outline. Its center: pieceX, pieceY.
2) A second region of the same silhouette formed only by a subtle change in the dash texture (a matching "gap" or patch). Its center: targetX, targetY.
These two centers are different points.
Return coordinates as percentages 0-100 of image width and height (x horizontal, y vertical).
Respond with ONLY this JSON object and nothing else:
{"pieceX":25.0,"pieceY":50.0,"targetX":70.0,"targetY":40.0}`;

  const res = await fetch(`${VISION_HOST}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VISION_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: 'user', content: prompt, images: [base64] }],
      stream: false,
      format: 'json',
      options: { temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vision API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.message?.content || '';
  if (!content.trim()) {
    log(`Vision empty content. raw=${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }
  const parsed = parseJSON(content);
  if (!parsed) {
    log(`Vision unparseable: ${content.slice(0, 200)}`);
    return null;
  }

  const clamp = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
  // Accept percent (0-100) or pixel-like values; convert to pixels
  const toPx = (v, dim) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dim / 2;
    if (n <= 100 && n >= 0) return clamp((n / 100) * dim, dim - 1);
    return clamp(n, dim - 1);
  };
  return {
    pieceX: toPx(parsed.pieceX, width),
    pieceY: toPx(parsed.pieceY, height),
    targetX: toPx(parsed.targetX, width),
    targetY: toPx(parsed.targetY, height),
    raw: parsed,
  };
}

function acquireLock() {
  if (existsSync(LOCKFILE)) {
    const pid = readFileSync(LOCKFILE, 'utf8').trim();
    try { process.kill(Number(pid), 0); console.error(`Bot already running (PID ${pid}).`); process.exit(1); } catch {}
    try { unlinkSync(LOCKFILE); } catch {}
  }
  writeFileSync(LOCKFILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCKFILE); } catch {} });
}

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  try {
    const arr = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    // Prefer the account selected when dispatching the bot (workflow / env)
    const preferred = process.env.LOGIN_EMAIL || process.env.EMAIL;
    if (preferred) {
      const hit = arr.filter(a => a.email === preferred);
      const rest = arr.filter(a => a.email !== preferred);
      return hit.length ? [...hit, ...rest] : arr;
    }
    return arr;
  } catch { return []; }
}

function saveAccounts(accounts) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function addAccount(email) {
  const accounts = loadAccounts();
  if (accounts.find(a => a.email === email)) {
    log('Account already exists.');
    return false;
  }
  accounts.push({ email, claims: 0, lastClaim: null });
  saveAccounts(accounts);
  log(`Account added: ${email}`);
  return true;
}

function bumpClaim(email) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.email === email);
  if (idx >= 0) {
    accounts[idx].claims = (accounts[idx].claims || 0) + 1;
    accounts[idx].lastClaim = new Date().toISOString();
    saveAccounts(accounts);
    return accounts[idx].claims;
  }
  return 0;
}

// The 2-fail captcha ladder must survive restarts: the platform's penalty is
// server-side and does NOT reset when we relaunch, so an in-memory counter
// would silently allow a 3rd attempt after a reboot.  Persist per account.
function getCaptchaFails(email) {
  const a = loadAccounts().find(x => x.email === email);
  return a ? (a.captchaFails || 0) : 0;
}
function setCaptchaFails(email, n) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.email === email);
  if (idx >= 0) {
    accounts[idx].captchaFails = n;
    saveAccounts(accounts);
  }
}

// Piece geometry from the widget's own captcha_image response header.
// {x,y} is the piece CENTER in canvas coordinates (450x280); sprite is the
// exact silhouette used to draw it — a perfect template for finding the hole.
const CANVAS_W = 450, CANVAS_H = 280;
let captchaGeom = null;
let pageGeomHooked = new WeakSet();

// v5 widget: captcha_image answers with JSON {scene, ref} (data URLs), both
// 450x280 canvases (scene + reference cut-out) drawn into CLOSED shadow roots
// — unreachable from page context, so the response body is the only source.
let v5Challenge = null;

function attachGeomCapture(page) {
  if (!page || pageGeomHooked.has(page)) return;
  pageGeomHooked.add(page);
  page.on('response', (res) => {
    if (!res.url().includes('/faucet/captcha_image')) return;
    (async () => {
      const hdr = res.headers()['x-captcha-piece'];
      if (!hdr) {
        // v5 challenge payload (JSON) — no legacy piece header.
        // Log WHICH frame issued it: idle-phase captures with no gate click
        // were observed (09:49/09:51), and distinguishing the main page from
        // an ad/popup frame tells us whether they count as round events.
        try {
          const txt = await res.text();
          const j = JSON.parse(txt);
          if (j && j.scene && j.ref) {
            const at = Date.now();
            const scenePath = `${SHOT_DIR}/v5-scene-${at}.png`;
            const refPath = `${SHOT_DIR}/v5-ref-${at}.png`;
            writeFileSync(scenePath, Buffer.from(String(j.scene).replace(/^data:image\/[\w+]+;base64,/, ''), 'base64'));
            writeFileSync(refPath, Buffer.from(String(j.ref).replace(/^data:image\/[\w+]+;base64,/, ''), 'base64'));
            v5Challenge = { scenePath, refPath, at };
            const furl = (() => { try { return res.frame().url(); } catch { return '?'; } })();
            let caller = '?';
            try {
              const stks = await res.frame().evaluate(() => (window.__capStacks || []).slice(-3));
              if (stks && stks.length) {
                const last = stks[stks.length - 1];
                caller = (last.stack || '').split('\n').slice(1, 5)
                  .map(s => s.trim()).join(' <- ').slice(0, 420);
              }
              const gc = await res.frame().evaluate(() => (window.__gateClicks || []).slice(-1)[0] || null);
              if (gc) caller += ` | gate ${gc.kind} trusted=${gc.trusted}${gc.key ? ' key=' + gc.key : ''}`;
            } catch { /* page gone */ }
            log(`v5 challenge: ${scenePath} (frame: ${furl.slice(0, 110)})\n    caller: ${caller}`);
          }
        } catch (e) { log(`v5 capture failed: ${e.message}`); }
        return;
      }
      let g = null;
      try { g = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')); } catch (e) {
        log(`geom parse failed: ${e.message}`);
      }
      if (!g || g.x == null || g.y == null) return;
      let spritePath = null;
      if (g.sprite) {
        try {
          spritePath = `${SHOT_DIR}/sprite-${Date.now()}.png`;
          writeFileSync(spritePath, Buffer.from(String(g.sprite).replace(/^data:image\/png;base64,/, ''), 'base64'));
        } catch (e) { spritePath = null; }
      }
      captchaGeom = { x: Number(g.x), y: Number(g.y), spritePath, at: Date.now() };
      log(`Captcha geometry: piece center canvas(${captchaGeom.x},${captchaGeom.y}) sprite=${spritePath}`);
    })().catch(e => log(`geom capture error: ${e.message}`));
  });
}
function freshGeom(maxAgeMs = 120000) {
  return captchaGeom && Date.now() - captchaGeom.at < maxAgeMs ? captchaGeom : null;
}

// Save the pristine background captured by the init-script hook above, but only
// when it belongs to the puzzle we are looking at: it must be recent AND within
// 20s of the X-Captcha-Piece header (same widget load), otherwise a stale bg
// would be matched against the wrong sprite and we would read a phantom hole.
let lastBgSaved = { at: null, path: null };
async function freshBgPath(page, geomAt) {
  try {
    const b = await page.evaluate(() => window.__ofBg || null);
    if (!b || !b.b64) return null;
    if (Date.now() - b.at > 120000) return null;
    if (geomAt && Math.abs(b.at - geomAt) > 20000) {
      log(`bg/geom skew ${((b.at - geomAt) / 1000).toFixed(1)}s — ignoring bg`);
      return null;
    }
    if (lastBgSaved.at === b.at && lastBgSaved.path) return lastBgSaved.path;
    const p = `${SHOT_DIR}/bg-${b.at}.png`;
    writeFileSync(p, Buffer.from(b.b64, 'base64'));
    lastBgSaved = { at: b.at, path: p };
    log(`bg captured ${b.size}B -> ${p} (geom skew ${geomAt ? ((b.at - geomAt) / 1000).toFixed(1) : '?'}s)`);
    return p;
  } catch (e) {
    log(`bg capture error: ${e.message.slice(0, 100)}`);
    return null;
  }
}

async function launchBrowser() {
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu'],
    viewport: { width: 1280, height: 800 },
  });
  // Playwright's default30s action timeout once turned a single missing
  // #walletInput/button into a 30s stall per step (login took minutes of pure
  // waiting).  Everything in this bot re-polls in its own loops — fast
  // failing actions are strictly better.
  ctx.setDefaultTimeout(8000);
  ctx.setDefaultNavigationTimeout(25000);
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  // Record the widget's pristine background PNG.  The widget builds it with
  // URL.createObjectURL; capturing those exact bytes lets the chain detector
  // run at native 450x280 canvas resolution instead of on a scaled screenshot
  // (z ~5-8 vs ~3-5, and no host-border mapping error).  Only 450x280 PNGs
  // are kept, so ad/asset blobs can never masquerade as the puzzle bg.
  await ctx.addInitScript(() => {
    try {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (obj) => {
        try {
          if (obj instanceof Blob && obj.size > 24) {
            obj.arrayBuffer().then((buf) => {
              try {
                const u = new Uint8Array(buf);
                if (!(u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47)) return;
                const dv = new DataView(buf);
                if (dv.getUint32(16) !== 450 || dv.getUint32(20) !== 280) return;
                let bin = '';
                const CH = 0x8000;
                for (let i = 0; i < u.length; i += CH) bin += String.fromCharCode.apply(null, u.subarray(i, i + CH));
                window.__ofBg = { b64: btoa(bin), size: u.length, at: Date.now() };
              } catch (e) { /* ignore */ }
            }).catch(() => {});
          }
        } catch (e) { /* ignore */ }
        return orig(obj);
      };
    } catch (e) { /* ignore */ }
  });
  // Who fetches /faucet/captcha_image without our gate click?  Idle-phase
  // auto-requests (~every 50-90s after a rejected Verify) were observed from
  // the main frame; capture a call-time stack so the log names the caller.
  // Also record WHO clicked .mc-gate: isTrusted=false means a page script
  // (synthetic), true means a human or Playwright input event.
  await ctx.addInitScript(() => {
    try {
      const mark = (url) => {
        try {
          if (String(url).indexOf('captcha_image') < 0) return;
          const st = (new Error()).stack || '';
          (window.__capStacks = window.__capStacks || [])
            .push({ at: Date.now(), href: String(location.href), stack: st.slice(0, 1500) });
        } catch (e) { /* ignore */ }
      };
      const of = window.fetch;
      if (of) {
        window.fetch = function (...a) { try { mark(a[0]); } catch (e) {} return of.apply(this, a); };
      }
      const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u, ...rest) {
        try { mark(u); } catch (e) {}
        return oo.call(this, m, u, ...rest);
      };
      const rec = (kind, e) => {
        try {
          const t = e.target;
          const gate = t && t.closest && t.closest('.mc-gate');
          if (!gate) return;
          (window.__gateClicks = window.__gateClicks || [])
            .push({ at: Date.now(), kind, trusted: !!e.isTrusted, key: e.key || '' });
        } catch (e2) { /* ignore */ }
      };
      for (const ev of ['pointerdown', 'click', 'keydown']) {
        document.addEventListener(ev, (e) => rec(ev, e), true);
      }
      // Press-point clearance: neutralize whatever covers our target so the
      // click reaches it (full-screen fixed overlays AND smaller ad layers
      // that elementFromPoint reports as topmost).  Returns 'clear' only
      // when the target selector itself is on top after neutralizing.
      window.__pressClear = function (x, y, allow) {
        try {
          let top = null;
          for (let i = 0; i < 4; i++) {
            top = document.elementFromPoint(x, y);
            if (!top) return 'null';
            if (top.matches && (top.matches(allow) || top.closest(allow))) return 'clear';
            top.style.setProperty('pointer-events', 'none', 'important');
          }
          top = document.elementFromPoint(x, y);
          if (top && top.matches && (top.matches(allow) || top.closest(allow))) return 'cleared';
          return 'blocked:' + (top ? `${top.tagName}#${top.id || '-'}` : 'null');
        } catch (e) { return 'err:' + e.message; }
      };
    } catch (e) { /* ignore */ }
  });
  ctx.on('page', attachGeomCapture);
  for (const p of ctx.pages()) attachGeomCapture(p);
  return ctx;
}

// Exact page<->canvas mapping from the widget host box (incl. border/padding).
// Retries: the widget DOM is re-rendering while we measure it (and ad-driven
// layout shifts can destroy the execution context mid-evaluate), and a null
// here silently downgrades the whole pipeline to the scaled screenshot path —
// the native-res background (the trusted input) is only used when we know
// where the canvas sits inside the clip.
async function getCanvasTransform(page) {
  for (let i = 0; i < 4; i++) {
    try {
      const t = await page.evaluate(() => {
        const h = document.querySelector('[id^="h_"]');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        if (r.width <= 40 || r.height <= 40) return null;
        const cs = getComputedStyle(h);
        const f = (v) => parseFloat(v) || 0;
        const insetL = f(cs.borderLeftWidth) + f(cs.paddingLeft);
        const insetT = f(cs.borderTopWidth) + f(cs.paddingTop);
        const insetR = f(cs.borderRightWidth) + f(cs.paddingRight);
        const insetB = f(cs.borderBottomWidth) + f(cs.paddingBottom);
        return {
          hostX: r.x, hostY: r.y, hostW: r.width, hostH: r.height,
          insetL, insetT, insetR, insetB,
          canvasX: r.x + insetL, canvasY: r.y + insetT,
          canvasW: Math.max(1, r.width - insetL - insetR),
          canvasH: Math.max(1, r.height - insetT - insetB),
        };
      });
      if (t) return t;
    } catch (e) { /* context destroyed mid-render; retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

function canvasToPage(t, cx, cy) {
  return { x: t.canvasX + (cx / CANVAS_W) * t.canvasW, y: t.canvasY + (cy / CANVAS_H) * t.canvasH };
}

// Ad networks (ccnsad/bmcdn6-style wrappers: data-cc-id, data-format) deliver
// an invisible full-viewport position:fixed div with z-index:2147483647 that
// swallows every pointer event — elementFromPoint reports it as a bare "DIV"
// sitting ABOVE the widget, so drags/Verify/cb clicks silently land on it.
// When such a wrapper covers (x,y) and the real target is deeper in the stack,
// disable its pointer-events (site UI is never touched: the wrapper must be
// fixed + z >= 1e6 + cover >=85% of the viewport). Returns a status string.
async function ensureClickable(page, x, y) {
  return page.evaluate(([px, py]) => {
    const stack = document.elementsFromPoint(px, py) || [];
    if (!stack.length) return 'empty-stack';
    const vw = innerWidth, vh = innerHeight;
    const ov = stack.find(el => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return false;
      const z = parseInt(cs.zIndex, 10);
      if (!Number.isFinite(z) || z < 1000000) return false;
      const r = el.getBoundingClientRect();
      return r.width >= vw * 0.85 && r.height >= vh * 0.85
        && r.left <= px && r.top <= py && r.right >= px && r.bottom >= py;
    });
    const top3 = stack.slice(0, 3).map(el =>
      `${el.tagName}#${el.id || '-'}.${(typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0] || '-'}`).join('|');
    if (!ov) return `clear top=${top3}`;
    ov.style.setProperty('pointer-events', 'none', 'important');
    const still = document.elementFromPoint(px, py);
    return `neutralized ${ov.tagName}.${ov.className}(cc=${ov.getAttribute('data-cc-id') || '-'}) -> top=${still ? `${still.tagName}#${still.id || '-'}` : 'null'}`;
  }, [x, y]).catch(e => `err:${String(e.message).slice(0, 80)}`);
}

// Human-ish drag of the puzzle piece: grab at fromC, ease to toC, small settle
// wiggle, release.  Kept at module level (page passed in) so the offline local
// rehearsal harness (local_drag.mjs) can exercise the EXACT production code.
//
// Robustness (verify6's drag silently missed the widget once on the live page):
//   - re-measure the canvas transform right before pressing — ads shift the
//     layout between the caller's measurement and the actual mouse press;
//   - hit-test the press point: it must land on the widget host (h_*), not an
//     ad/overlay that slid in on top;
//   - after pointerdown, confirm the widget took the grab (pt_ is written only
//     when the widget's own distance test passed) before moving, otherwise
//     lift and retry with a fresh measurement.
// Returns true when the press sequence completed.
async function dragCanvas(page, tr, fromC, toC) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = (await getCanvasTransform(page).catch(() => null)) || tr;
    if (!t) { log('drag: no canvas transform'); return false; }
    const f = canvasToPage(t, fromC.x, fromC.y);
    const to = canvasToPage(t, toC.x, toC.y);
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const id = el.id || '';
      // closed shadow root retargets hit tests to the host; accept a direct
      // canvas hit too in case the browser pierces it
      return (id.startsWith('h_') || el.tagName === 'CANVAS') ? 'ok' : (id || el.tagName);
    }, [f.x, f.y]).catch(() => 'err');
    if (hit !== 'ok') {
      // Invisible ad wrapper (data-cc-id / z-max / full-viewport fixed) is the
      // known cause — neutralize it and retry; otherwise log the stack.
      const esc = await ensureClickable(page, f.x, f.y);
      log(`drag: press point blocked by "${hit}" at (${f.x.toFixed(0)},${f.y.toFixed(0)}) (attempt ${attempt + 1}) ensure=${esc}`);
      await sleep(400);
      continue;
    }
    const grabWasEmpty = await page.evaluate(() => {
      const el = document.querySelector('[id^="pt_"]');
      return !(el && el.value);
    }).catch(() => true);

    await page.mouse.move(f.x, f.y, { steps: 4 });
    await sleep(50 + Math.random() * 70);
    await page.mouse.down();
    await sleep(35 + Math.random() * 45);

    // The widget writes pt_ only when pointerdown passed its grab test
    // (within pieceR*1.15 of the piece) — an empty-to-empty pt_ means the
    // press landed but was rejected (stale coords / widget state).
    const grabOk = await page.evaluate((wasEmpty) => {
      const el = document.querySelector('[id^="pt_"]');
      return !wasEmpty || !!(el && el.value);
    }, grabWasEmpty).catch(() => true);
    if (!grabOk) {
      await page.mouse.up();
      log(`drag: widget rejected the grab (attempt ${attempt + 1}) — re-measure`);
      await sleep(400);
      continue;
    }

    // 10-14 eased steps with light jitter: ~1.2-2.0s end to end.  The widget
    // force-fails at 50s and detection already costs 8-20s, so a slow drag
    // (the old 16-23 steps x 25-60ms slept 4-6s) was blowing the clock on
    // retry/nudge rounds.  A human flick takes well under a second anyway —
    // speed here is both safety and better camouflage.
    const steps = 10 + Math.floor(Math.random() * 5);
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const ease = u * u * (3 - 2 * u);
      const mx = f.x + (to.x - f.x) * ease + (Math.random() - 0.5) * 2;
      const my = f.y + (to.y - f.y) * ease + (Math.random() - 0.5) * 2;
      await page.mouse.move(mx, my);
      await sleep(14 + Math.random() * 18);
    }
    // Small settle wiggle on target to register drop
    await page.mouse.move(to.x + (Math.random() - 0.5) * 4, to.y + (Math.random() - 0.5) * 4, { steps: 2 });
    await sleep(50);
    await page.mouse.up();
    // ca_/captcha_answer is written synchronously in the widget's endDrag —
    // no need to sit on a long tail before reading it back.
    await sleep(250);
    return true;
  }
  log('drag: press never engaged the widget');
  return false;
}

// Detection runs in screenshot-clip space; convert to canvas (450x280) coords.
function clipToCanvas(t, clip, x, y) {
  const hostRelX = x + (clip.x - t.hostX) - t.insetL;
  const hostRelY = y + (clip.y - t.hostY) - t.insetT;
  return { x: hostRelX * CANVAS_W / t.canvasW, y: hostRelY * CANVAS_H / t.canvasH };
}

async function gotoRetry(page, url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const cleared = await waitForCloudflare(page, 90);
      if (!cleared) {
        // Returning true here would make every caller navigate onward from a
        // LIVE challenge — each navigation spawns a fresh challenge instance
        // and verification never gets a stable window.  waitForCloudflare
        // already retried internally (clicks + up to 3 reloads); give up.
        log(`goto: challenge not cleared after ${url.slice(0, 60)}`);
        return false;
      }
      return true;
    } catch (e) {
      log(`goto attempt ${i + 1}: ${e.message.slice(0, 60)}`);
      await sleep(3000 + i * 2000);
    }
  }
  return false;
}

async function getChallengeState(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const pageUrl = page.url() || '';

  // Real site content present → past CF
  const hasForm = await page.evaluate(() => !!document.querySelector('form[action*="faucet/verify"]')).catch(() => false);
  const onSite =
    hasForm ||
    bodyText.includes('Claim Now') ||
    bodyText.includes('Login / Register') ||
    bodyText.includes('Logout') ||
    bodyText.includes('Dashboard') ||
    bodyText.includes('Drag the shape') ||
    bodyText.includes('has been sent') ||
    bodyText.includes('Please wait') ||
    bodyText.includes('Verification Required') ||
    (bodyText.includes('Faucet') && bodyText.length > 80);
  if (onSite) return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };

  // Blank/interstitial page after CF redirect (auth/login?__cf_chl_rt_tk=...) or empty body with CF frame
  const blankBody = bodyText.trim().length < 20;
  const cfTokenUrl = pageUrl.includes('__cf_chl_rt_tk') || pageUrl.includes('cdn-cgi/challenge');
  let hasAnyCfFrame = false;
  for (const frame of page.frames()) {
    try {
      const u = frame.url() || '';
      if (u.includes('challenges.cloudflare.com') || u.includes('turnstile')) { hasAnyCfFrame = true; break; }
    } catch {}
  }
  if (cfTokenUrl || (blankBody && hasAnyCfFrame) || (blankBody && !bodyText.trim())) {
    // Still waiting on CF handoff — treat as challenge so waitForCloudflare keeps waiting
    if (cfTokenUrl || hasAnyCfFrame) {
      return await describeFrameState(page, true);
    }
    // Truly blank with no frames: give the page a moment; if still blank after long, not a challenge
    if (blankBody && pageUrl.includes('onlyfaucet.com')) {
      return await describeFrameState(page, hasAnyCfFrame);
    }
  }

  // Strict CF challenge detection — main challenge heading only (match rosecrypto).
  // The SPINNER phase ("Verifying you are human. This may take a few seconds.")
  // REPLACES that heading while our click is being verified — reading it as
  // "cleared" is what let login() navigate mid-verify, which restarts the
  // challenge from scratch (fresh Ray ID) and is why verification never once
  // got an uninterrupted window to finish.
  const bodyVerifying =
    bodyText.includes('Verifying you are human') ||
    bodyText.includes('This may take a few seconds');
  const onChallenge =
    bodyText.includes('Performing security verification') ||
    bodyText.includes('Just a moment...') ||
    bodyVerifying;
  if (!onChallenge) return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };

  // Extra guard: site captcha UI also present → treat as site
  if (
    bodyText.includes('Drag the shape') ||
    bodyText.includes('Claim Now') ||
    bodyText.includes('has been sent') ||
    bodyText.includes('Please complete the captcha')
  ) {
    return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };
  }

  const d = await describeFrameState(page, true);
  return { ...d, verifying: d.verifying || bodyVerifying };
}

async function describeFrameState(page, onChallenge) {
  let verifying = false;
  let verifyHuman = false;
  let hasChallengeFrame = false;
  let frameOpaque = false;
  for (const frame of page.frames()) {
    try {
      const url = frame.url() || '';
      if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
        hasChallengeFrame = true;
        const t = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (!t.trim()) frameOpaque = true;
        if (t.includes('Verifying') || t.includes('verifying')) verifying = true;
        if (t.includes('Verify you are human') || t.includes('verify you are human')) verifyHuman = true;
      }
    } catch {}
  }
  if (!onChallenge) return { onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false };
  return { onChallenge: true, verifying, verifyHuman, hasChallengeFrame, frameOpaque };
}

// Trusted-but-human pointer press.  Turnstile's interactive checkbox engaged
// only intermittently on raw page.mouse.click (0ms down/up): 5 dead-on clicks
// landed and only one ever started a verify spinner.  Hover dwell + press
// hold + small jitter matches real pointer timing closely enough for the
// widget to accept the interaction.
async function humanClick(page, x, y) {
  const jx = x + (Math.random() * 4 - 2);
  const jy = y + (Math.random() * 4 - 2);
  await page.mouse.move(jx, jy, { steps: 8 + Math.floor(Math.random() * 6) });
  await sleep(120 + Math.random() * 180);
  await page.mouse.down();
  await sleep(60 + Math.random() * 70);
  await page.mouse.up();
}

async function clickChallengeBody(page) {
  // Prefer Playwright frame.frameElement() — CF widget often lives in shadow DOM,
  // so document.querySelectorAll('iframe') returns nothing.
  for (const frame of page.frames()) {
    try {
      const url = frame.url() || '';
      if (!url.includes('challenges.cloudflare.com') && !url.includes('turnstile') && !url.includes('cloudflare') && !url.includes('cf-')) continue;
      const el = await frame.frameElement().catch(() => null);
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      const local = await frame.evaluate(() => {
        const input = document.querySelector('input[type="checkbox"]');
        if (input) {
          const r = input.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        const body = document.body?.getBoundingClientRect();
        const h = body && body.height > 10 ? body.height : 65;
        return { x: 25, y: h / 2 };
      }).catch(() => ({ x: 25, y: 32 }));
      const pageX = box.x + local.x;
      const pageY = box.y + local.y;
      log(`Clicking CF via frameElement at (${Math.round(pageX)}, ${Math.round(pageY)}) box=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)} url=${url.slice(0, 80)}`);
      await humanClick(page, pageX, pageY);
      return true;
    } catch {}
  }

  const allIframes = await page.evaluate(() =>
    [...document.querySelectorAll('iframe')].map(f => {
      const r = f.getBoundingClientRect();
      return { src: (f.src || '').slice(0, 100), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })
  ).catch(() => []);
  log(`DOM iframes (${allIframes.length}): ${JSON.stringify(allIframes.slice(0, 5))}`);

  const iframePos = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')];
    const cf = iframes.filter(f => {
      const src = f.src || '';
      return src.includes('challenges.cloudflare.com') || src.includes('turnstile') || src.includes('cf-chl') || src.includes('cloudflare');
    });
    const candidates = cf.length ? cf : iframes.filter(f => {
      const r = f.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 200;
    });
    for (const iframe of candidates) {
      const r = iframe.getBoundingClientRect();
      const s = getComputedStyle(iframe);
      if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') {
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    }
    return null;
  }).catch(() => null);

  if (iframePos) {
    log(`CF iframe at (${Math.round(iframePos.x)},${Math.round(iframePos.y)}) ${Math.round(iframePos.w)}x${Math.round(iframePos.h)}`);
    const pageX = iframePos.x + 25;
    const pageY = iframePos.y + iframePos.h / 2;
    log(`Clicking CF iframe area at (${Math.round(pageX)}, ${Math.round(pageY)})`);
    await humanClick(page, pageX, pageY);
    return true;
  }
  log('Clicking CF checkbox fallback at (215, 336)');
  await humanClick(page, 215, 336);
  return false;
}

async function waitForCloudflare(page, maxSec = 90) {
  let verifyingSince = 0;
  let lastClickAt = 0;
  let lastLog = 0;
  let reloadCount = 0;
  let assumeVerifyUntil = 0; // after a click, wait — widget may show "Verifying..." with unreadable frame text
  let frameGoneSince = 0;

  for (let i = 0; i < maxSec; i++) {
    const state = await getChallengeState(page).catch(() => ({ onChallenge: false, verifying: false, verifyHuman: false, frameOpaque: false }));
    if (!state.onChallenge) {
      if (i > 0) log('CF cleared');
      return true;
    }

    if (Date.now() - lastLog > 10000) {
      log(`CF state: verifying=${state.verifying} verifyHuman=${state.verifyHuman} frame=${state.hasChallengeFrame} opaque=${state.frameOpaque} i=${i}`);
      lastLog = Date.now();
      try { await page.screenshot({ path: `${SHOT_DIR}/cf-debug-${Date.now()}.png` }); } catch {}
    }

    // Track how long the challenge frame has been missing — brief gaps are normal during verify
    if (!state.hasChallengeFrame) {
      if (!frameGoneSince) frameGoneSince = Date.now();
    } else {
      frameGoneSince = 0;
    }

    // Verifying: from frame text OR shortly after our own click (opaque frame can't report it)
    const inVerifyWait = state.verifying || Date.now() < assumeVerifyUntil;
    if (inVerifyWait) {
      if (!verifyingSince) verifyingSince = Date.now();
      // Stay patient — interrupting verify restarts the challenge
      if (Date.now() - verifyingSince > 90000 && reloadCount < 3) {
        // 90s, not 45s: a slow interactive verify (observed a 60s+ spinner)
        // gets RESTARTED by a reload — only recover a genuinely wedged one.
        log('CF verifying stuck, reloading...');
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
        await sleep(5000);
        verifyingSince = 0;
        lastClickAt = 0;
        assumeVerifyUntil = 0;
        frameGoneSince = 0;
        reloadCount++;
        continue;
      }
      await sleep(2000);
      continue;
    }

    // Explicit checkbox text (readable frame)
    if (state.verifyHuman) {
      const now = Date.now();
      if (!lastClickAt || now - lastClickAt > 10000) {
        log('Clicking Verify you are human...');
        await clickChallengeBody(page);
        lastClickAt = now;
        verifyingSince = 0;
        assumeVerifyUntil = Date.now() + 30000; // long wait — do not re-click while widget verifies
        await sleep(3000);
        const still = await getChallengeState(page).catch(() => ({ onChallenge: false }));
        if (!still.onChallenge) return true;
      } else {
        await sleep(2000);
      }
      continue;
    }

    // Opaque frame / present frame with no explicit state: wait before first click,
    // then click once and give a long verify window.
    if (state.frameOpaque || state.hasChallengeFrame) {
      const now = Date.now();
      const waitedNoClick = !lastClickAt || now - lastClickAt > 20000;
      if (waitedNoClick && i >= 4) {
        log('CF frame present, clicking widget once...');
        await clickChallengeBody(page);
        lastClickAt = now;
        assumeVerifyUntil = Date.now() + 30000;
        verifyingSince = 0;
        await sleep(3000);
        const still = await getChallengeState(page).catch(() => ({ onChallenge: false }));
        if (!still.onChallenge) return true;
      } else {
        await sleep(2000);
      }
      continue;
    }

    // On challenge but frame missing — only reload after a sustained gap
    if (i > 3) {
      const now = Date.now();
      const frameGoneMs = frameGoneSince ? now - frameGoneSince : 0;
      if (!lastClickAt || now - lastClickAt > 8000) {
        if (!state.hasChallengeFrame && frameGoneMs > 15000 && reloadCount < 3) {
          log('CF widget not loaded 15s, reloading...');
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
          await sleep(6000);
          reloadCount++;
          lastClickAt = 0;
          assumeVerifyUntil = 0;
          frameGoneSince = 0;
          continue;
        }
        if (i > 40 && reloadCount < 3) {
          log('CF stuck too long, reloading...');
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
          await sleep(5000);
          reloadCount++;
          lastClickAt = 0;
          assumeVerifyUntil = 0;
          frameGoneSince = 0;
          continue;
        }
        if (i > 75 || reloadCount >= 3) {
          log('CF giving up after many attempts');
          return false;
        }
        log('On challenge, clicking widget fallback...');
        await humanClick(page, 215, 336);
        lastClickAt = now;
        assumeVerifyUntil = Date.now() + 30000;
        await sleep(6000);
      } else {
        await sleep(2000);
      }
      continue;
    }

    await sleep(2000);
  }
  log('waitForCloudflare timed out');
  try { await page.screenshot({ path: `${SHOT_DIR}/cf-timeout-${Date.now()}.png` }); } catch {}
  return false;
}

async function solveTurnstile(page) {
  log('Solving Turnstile...');
  const tb = await page.evaluate(() => {
    const el = document.querySelector('.cf-turnstile') ||
      document.querySelector('[data-sitekey]') ||
      document.querySelector('div[class*="turnstile"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }).catch(() => null);

  if (!tb) {
    log('No turnstile found');
    return false;
  }

  for (let i = 0; i < 10; i++) {
    await page.mouse.move(tb.x, tb.y, { steps: 5 });
    await sleep(200);
    await page.mouse.click(tb.x, tb.y);
    await sleep(1500);

    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]') ||
        document.querySelector('textarea[name="cf-turnstile-response"]');
      return input?.value || '';
    }).catch(() => '');

    if (token.length > 10) {
      log(`Turnstile solved (token: ${token.slice(0, 20)}...)`);
      return true;
    }
  }

  // Fallback: use clickChallengeBody if container click didn't produce token
  log('Turnstile container click failed, trying challenge body click...');
  await clickChallengeBody(page);
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]') ||
        document.querySelector('textarea[name="cf-turnstile-response"]');
      return input?.value || '';
    }).catch(() => '');
    if (token.length > 10) {
      log(`Turnstile solved via body click (token: ${token.slice(0, 20)}...)`);
      return true;
    }
  }

  log('Turnstile failed');
  return false;
}

async function hasTurnstile(page) {
  return await page.evaluate(() =>
    !!document.querySelector('.cf-turnstile') ||
    !!document.querySelector('input[name="cf-turnstile-response"]') ||
    [...document.querySelectorAll('iframe')].some(f => {
      const s = f.src || '';
      return s.includes('challenges.cloudflare.com') || s.includes('turnstile');
    })
  ).catch(() => false);
}

async function ensureCleared(page) {
  let ok = await waitForCloudflare(page, 90);
  if (!ok) {
    // One patient retry: pressing onward from a live challenge (navigating,
    // filling, clicking) restarts it — the loop that consumed 4 minutes in
    // once23.  Callers must treat a false return as "stop, do not navigate".
    log('ensureCleared: challenge not cleared, retrying once');
    ok = await waitForCloudflare(page, 60);
  }
  if (!ok) {
    log('ensureCleared: waitForCloudflare failed');
    try { await page.screenshot({ path: `${SHOT_DIR}/cleared-fail-${Date.now()}.png`, fullPage: true }); } catch {}
  }
  // After CF, blank handoff pages (auth/login?__cf_chl_rt_tk=) need a beat to render
  for (let i = 0; i < 8; i++) {
    const blank = await page.evaluate(() => (document.body?.innerText || '').trim().length < 20).catch(() => false);
    const tokenUrl = page.url().includes('__cf_chl_rt_tk');
    if (!blank && !tokenUrl) break;
    log(`ensureCleared: waiting for page render (blank=${blank} tokenUrl=${tokenUrl})`);
    await sleep(2000);
    if (i >= 3 && tokenUrl) {
      // Force a clean load without the challenge handoff token
      const clean = page.url().split('?')[0];
      try { await page.goto(clean, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
      await waitForCloudflare(page, 60);
    }
  }
  if (await hasTurnstile(page)) {
    const token = await page.evaluate(() =>
      (document.querySelector('input[name="cf-turnstile-response"]')?.value || '')
    ).catch(() => '');
    if (token.length < 10) await solveTurnstile(page);
  }
  return ok;
}

async function isLoggedIn(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (bodyText.includes('Login / Register') && !bodyText.includes('Claim Now')) return false;
  if (bodyText.includes('Logout') || bodyText.includes('Dashboard')) return true;
  return await page.evaluate(() => !!document.querySelector('form[action*="faucet/verify"]')).catch(() => false);
}

async function login(page, email) {
  log('Clicking Login / Register...');
  if (!(await ensureCleared(page))) {
    log('login: CF challenge will not clear — aborting (navigating would restart it)');
    return false;
  }
  // If we're not on a page with the login entry point, go home first
  const hasLoginEntry = await page.evaluate(() =>
    (document.body?.innerText || '').includes('Login / Register')
  ).catch(() => false);
  if (!hasLoginEntry && !page.url().includes('/auth/login')) {
    log('Login entry not found, reloading home...');
    await gotoRetry(page, BASE_URL);
    await sleep(2000);
    if (!(await ensureCleared(page))) {
      log('login: challenge after home reload — aborting');
      return false;
    }
  }
  await page.click('text=Login / Register').catch(() => {});
  await sleep(2000);
  if (!(await ensureCleared(page))) {
    log('login: challenge after Login click — aborting');
    return false;
  }

  // Reconcile to a clean, cleared login page.  A CF interstitial handoff can
  // land on ANY url (recover1: cleared back onto / with no form) and can
  // carry a ?__cf_chl_rt_tk token that never renders the form — so never
  // start the wallet wait from wherever the challenge dance left us.
  const loginUrl = `${BASE_URL}/auth/login`;
  let hasWallet = await page.evaluate(() => !!document.querySelector('#walletInput')).catch(() => false);
  if (!hasWallet && (!page.url().startsWith(loginUrl) || page.url().includes('__cf_chl_rt_tk'))) {
    log(`login: going to /auth/login from ${page.url().slice(0, 80)}`);
    try { await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
    if (!(await ensureCleared(page))) {
      log('login: challenge at login page — aborting');
      return false;
    }
  }

  // Wait for the wallet input on /auth/login; if the form never renders
  // there, fall back to the home-page Login / Register entry (modal mount).
  for (let i = 0; i < 10; i++) {
    hasWallet = await page.evaluate(() => !!document.querySelector('#walletInput')).catch(() => false);
    if (hasWallet) break;
    log(`Waiting for #walletInput (${i})... url=${page.url().slice(0, 100)}`);
    await sleep(1500);
  }
  if (!hasWallet) {
    log('No form on /auth/login — trying home Login / Register entry');
    if (!(await gotoRetry(page, BASE_URL))) {
      log('login: home nav failed during form fallback');
      return false;
    }
    await sleep(2000);
    if (!(await ensureCleared(page))) {
      log('login: challenge at home during form fallback — aborting');
      return false;
    }
    await page.click('text=Login / Register').catch(() => {});
    await sleep(3000);
    for (let i = 0; i < 6 && !hasWallet; i++) {
      hasWallet = await page.evaluate(() => !!document.querySelector('#walletInput')).catch(() => false);
      if (!hasWallet) { log(`home form wait (${i})... url=${page.url().slice(0, 100)}`); await sleep(1500); }
    }
  }
  if (!hasWallet) {
    log('walletInput never appeared');
    try { await page.screenshot({ path: `${SHOT_DIR}/login-nowallet-${Date.now()}.png`, fullPage: true }); } catch {}
    return false;
  }
  await page.fill('#walletInput', email).catch(() => {});
  await sleep(1000);
  if (await hasTurnstile(page)) {
    const token = await page.evaluate(() =>
      (document.querySelector('input[name="cf-turnstile-response"]')?.value || '')
    ).catch(() => '');
    if (token.length < 10) await solveTurnstile(page);
  }
  await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
  await sleep(5000);
  if (!(await ensureCleared(page))) {
    log('login: challenge after submit — aborting before retry');
    return false;
  }
  if (await isLoggedIn(page)) {
    log('Login successful!');
    return true;
  }
  // Retry once with a fresh challenge clear
  if (!(await ensureCleared(page))) {
    log('login: challenge before retry — aborting');
    return false;
  }
  await page.fill('#walletInput', email).catch(() => {});
  await sleep(500);
  await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
  await sleep(5000);
  await ensureCleared(page);
  if (await isLoggedIn(page)) {
    log('Login successful (retry)!');
    return true;
  }
  try { await page.screenshot({ path: `${SHOT_DIR}/login-fail-${Date.now()}.png`, fullPage: true }); } catch {}
  const dbg = await page.evaluate(() => ({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 300),
    hasWallet: !!document.querySelector('#walletInput'),
    hasTurn: !!document.querySelector('.cf-turnstile'),
    frames: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 80)),
  })).catch(() => ({}));
  log(`Login failed debug: ${JSON.stringify(dbg)}`);
  return false;
}

async function dismissSweetAlert(page) {
  // Capture the site's own message before dismissing — after a rejected
  // Verify this is the only place the rejection reason (wrong answer vs bot
  // telemetry vs rate limit) is ever visible.
  const modalText = await page.evaluate(() => {
    const els = [...document.querySelectorAll(
      '.swal2-popup,.sweet-alert,[role="alert"],.swal2-container,.modal.show')];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 50 && r.height > 30) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 200);
      }
    }
    return '';
  }).catch(() => '');
  if (modalText) log(`modal: ${modalText}`);
  const clicked = await page.evaluate(() => {
    let ok = false;
    const selectors = [
      '.swal2-confirm', '.swal2-cancel', '.swal2-close',
      '.swal2-container button', '.sweet-alert button.confirm',
      'button.close', '[aria-label="close"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.click(); ok = true; }
    }
    // Custom error cards with an X close control
    const cards = [...document.querySelectorAll('div,aside,section')].filter(el => {
      const t = (el.innerText || '');
      return t.includes('Please complete the captcha') && el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().width < 600;
    });
    for (const card of cards) {
      const x = [...card.querySelectorAll('button,a,span,i,[class*="close"],[class*="times"]')]
        .find(el => /×|x|close/i.test((el.innerText || '').trim()) || /close|times/i.test(el.className?.toString?.() || ''));
      if (x) { x.click(); ok = true; }
    }
    // Escape closes most modals
    return ok;
  }).catch(() => false);
  if (clicked) await sleep(400);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(200);
}

async function getPageState(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const answer = document.querySelector('[name="captcha_answer"], [id^="ca_"]')?.value || '';
      const waitMatch = text.match(/Please wait\s*(\d+):(\d+)/i);
      const waitSec = waitMatch ? Number(waitMatch[1]) * 60 + Number(waitMatch[2]) : null;
      // Temporary ban: "Time remaining to unlock: 46 minutes 51 seconds"
      const temporarilyBlocked = /You Have Been Temporarily Blocked|blocked due to multiple failed CAPTCHA/i.test(text);
      let blockSec = null;
      if (temporarilyBlocked) {
        const hm = text.match(/Time remaining to unlock:\s*(\d+)\s*hours?\s*(\d+)\s*minutes?(?:\s*(\d+)\s*seconds?)?/i);
        const mm = text.match(/Time remaining to unlock:\s*(\d+)\s*minutes?\s*(\d+)\s*seconds?/i);
        const ss = text.match(/Time remaining to unlock:\s*(\d+)\s*seconds?/i);
        if (hm) blockSec = Number(hm[1]) * 3600 + Number(hm[2] || 0) * 60 + Number(hm[3] || 0);
        else if (mm) blockSec = Number(mm[1]) * 60 + Number(mm[2] || 0);
        else if (ss) blockSec = Number(ss[1]);
        else blockSec = 3600; // default full hour if unparsed
      }
      const h = document.querySelector('[id^="h_"]');
      let hRect = null;
      if (h) {
        const r = h.getBoundingClientRect();
        if (r.width > 40 && r.height > 40) hRect = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      const cb = document.querySelector('[id^="cb_"]');
      let cbRect = null;
      if (cb) {
        const r = cb.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) cbRect = { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }
      const verifyBtn = document.querySelector('[id^="cb_btn_"]');
      let verifyRect = null;
      if (verifyBtn) {
        const r = verifyBtn.getBoundingClientRect();
        if (r.width > 0) verifyRect = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return {
        text: text.slice(0, 800),
        success: text.includes('has been sent'),
        verification: text.includes('Verification Required'),
        puzzle: text.includes('Drag the shape'),
        v5: text.includes('Tap every creature'),   // v5 tap-widget challenge card
        captchaError: text.includes('Please complete the captcha'),
        verificationFailed: /verification failed/i.test(text),
        cooldown: waitSec !== null && !temporarilyBlocked,
        waitSec,
        temporarilyBlocked,
        blockSec,
        claimBtn: /Claim Now/i.test(text),
        captchaAnswer: answer,
        hRect, cbRect, verifyRect,
        hasForm: !!document.querySelector('form[action*="faucet/verify"]'),
      };
    });
  } catch (e) {
    return { text: '', success: false, verification: false, puzzle: false, v5: false, captchaError: false, verificationFailed: false, cooldown: false, waitSec: null, temporarilyBlocked: false, blockSec: null, claimBtn: false, captchaAnswer: '', hRect: null, cbRect: null, verifyRect: null, hasForm: false, navError: true };
  }
}

// Raw rect read: no scroll, no settle.  Used for the drift check right after
// a capture — scrolling again there could itself change what we measure.
async function measureBox(page) {
  return page.evaluate(() => {
    if (!document || !document.body) return null;
    const h = document.querySelector('[id^="h_"]');
    if (h) {
      const r = h.getBoundingClientRect();
      if (r.width > 80 && r.height > 80) return { x: r.x, y: r.y, w: r.width, h: r.height, src: 'h_' };
    }
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if ((n.textContent || '').includes('Drag the shape')) {
          let el = n.parentElement;
          for (let i = 0; i < 10 && el; i++) {
            const r = el.getBoundingClientRect();
            if (r.width > 250 && r.height > 180) return { x: r.x, y: r.y, w: r.width, h: r.height, src: 'text' };
            el = el.parentElement;
          }
        }
      }
    } catch (e) { /* mid-navigation */ }
    return null;
  }).catch(() => null);
}

async function getPuzzleBox(page) {
  // Scroll into center first so clip stays inside viewport (ads shift layout)
  await page.evaluate(() => {
    if (!document || !document.body) return;
    const h = document.querySelector('[id^="h_"]');
    if (h) { h.scrollIntoView({ block: 'center', behavior: 'instant' }); return; }
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if ((n.textContent || '').includes('Drag the shape')) {
          let el = n.parentElement;
          for (let i = 0; i < 10 && el; i++) {
            const r = el.getBoundingClientRect();
            if (r.width > 250 && r.height > 180) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); return; }
            el = el.parentElement;
          }
        }
      }
    } catch (e) { /* mid-navigation */ }
  }).catch(() => {});
  await sleep(400);

  return measureBox(page);
}

// Ads inject AND collapse around the widget, shifting it 100-250px within a
// few hundred ms — live-observed: one capture held an ad+heading where the
// canvas should be, its re-detect nine seconds later held canvas+footer (the
// ad had collapsed).  Both are stale-clip reads: find_hole then "scores"
// garbage and the gate can only refuse.  Measure -> shoot -> re-measure:
// capture only when the rect did not move during the shot, so clip, rect
// (canvas mapping) and the pixels all describe the same frame.
async function captureWidgetFrame(page, tag, tries = 2) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  let last = null;
  for (let i = 0; i < tries; i++) {
    // First try trusts the caller's recent scroll (keeps the common path
    // fast); a retry re-centers and settles properly via getPuzzleBox.
    let box = await measureBox(page);
    if (!box || box.y < 0 || box.x < 0 || box.y + box.h > vp.height || box.x + box.w > vp.width) {
      box = await getPuzzleBox(page);
    }
    if (!box) break;
    const clip = clampClip(box, vp);
    const path = `${SHOT_DIR}/${tag}-${stamp()}.png`;
    const shot = await page.screenshot({ path, clip }).catch(() => null);
    if (!shot) break;
    const after = await measureBox(page);
    const drift = after
      ? Math.hypot(after.x - box.x, after.y - box.y)
        + Math.abs((after.w ?? box.w) - box.w) + Math.abs((after.h ?? box.h) - box.h)
      : 999;
    log(`capture ${tag}: ${shot.length}B drift=${drift.toFixed(1)}px${i ? ` (retry ${i})` : ''}`);
    last = { shot, path, clip, drift };
    if (drift <= 5 && shot.length >= 8000) return last;
    await sleep(700); // let the ad storm settle before re-measuring
  }
  return last;
}

async function handlePuzzle(page, attempt = 0) {
  if (await isV5Widget(page)) return handlePuzzleV5(page, attempt);
  log(`Solving puzzle (attempt ${attempt + 1})...`);
  if (attempt >= 4) { log('Max puzzle attempts'); return false; }
  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

  await dismissSweetAlert(page);
  await page.evaluate(() => {
    document.querySelectorAll('[class^="cc-"]').forEach(el => el.remove());
  }).catch(() => {});
  await sleep(300);

  // Wait for puzzle widget fully rendered (instruction text or sized h_ host)
  let box = null;
  let cbClicks = 0;
  for (let i = 0; i < 15; i++) {
    const st = await getPageState(page);
    if (st.captchaError) await dismissSweetAlert(page);
    if (st.puzzle || st.hRect) {
      markWidgetShown();
      if (pastBailWindow()) return await bailOutOfPuzzle(page, 'widget detection too slow');
      box = await getPuzzleBox(page);
      if (box) {
        // Ensure canvas content rendered: screenshot must not be tiny/blank
        const probe = await page.screenshot({
          clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.w, 1280), height: Math.min(box.h, 800) },
        }).catch(() => null);
        if (probe && probe.length > 8000) {
          log(`Puzzle rendered (${probe.length} bytes)`);
          break;
        }
        log(`Widget present but not rendered yet (${probe?.length ?? 0} bytes)`);
        if (i >= 14) break;
        box = null;
      }
    }
    // Cap checkbox re-clicks: spinning cb_ when widget never reopens wastes a claim
    if (st.cbRect && st.verification && cbClicks < 2) {
      // Gate only the FIRST click of this round: after our own click
      // spacingLeft() is nonzero by construction (noteRoundStart) and must
      // not abort the very round it just measured.
      if (cbClicks === 0) {
        const spacingLeft = roundSpacingLeft();
        if (spacingLeft > 0 && bailFresh() && !consumeRecoveryPermit()) {
          // Opening now would push the 7-minute event window over the block
          // threshold — but only a BAIL-fresh open owes that floor; a clean
          // round may start immediately (visible widget = click it).
          log(`Round spacing: ${Math.round(spacingLeft / 1000)}s left (bail-fresh) — NOT opening the widget`);
          return 'aborted';
        }
      }
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const cb = await getPageState(page);
      if (cb.cbRect) {
        const esc = await ensureClickable(page, cb.cbRect.x, cb.cbRect.y);
        if (esc.startsWith('neutralized')) log(`cb click: ${esc}`);
        noteRoundStart(); // the captcha_image REQUEST is the round's first event
        await page.mouse.click(cb.cbRect.x, cb.cbRect.y);
        cbClicks++;
        clearWidgetClock(); // a fresh captcha_image => fresh 50s countdown
        log(`Clicked verification checkbox (${cbClicks}/2)`);
      }
    }
    // After 2 failed checkbox opens with no widget, hard-reload faucet page once
    if (i === 7 && !box && cbClicks >= 2) {
      log('Widget stuck after checkbox retries — reloading faucet page');
      await gotoRetry(page, FAUCET_URL, 3);
      clearWidgetClock();
      await sleep(2000);
      const st2 = await getPageState(page);
      if (st2.success || st2.cooldown) return true;
      continue;
    }
    log(`Waiting for puzzle widget... (${i + 1}/15)`);
    await sleep(2000);
  }

  if (!box) {
    log('Puzzle widget not found');
    await page.screenshot({ path: `${SHOT_DIR}/no-widget-${ts()}.png`, fullPage: true }).catch(() => {});
    // Widget gone might mean claim navigated to success/cooldown
    const st = await getPageState(page);
    if (st.success || st.cooldown) return true;
    return false;
  }
  // Fresh measure + drift-verified capture: the wait loop's box may already
  // be stale by now (ads move the widget between probe and shot — a stale
  // clip captures ad/heading pixels instead of the canvas).
  const cap = await captureWidgetFrame(page, 'puzzle');
  if (!cap || cap.shot.length < 8000) {
    log(`Screenshot looks blank (${cap ? cap.shot.length : 0} bytes) — waiting and retrying once`);
    await sleep(2500);
    const cap2 = await captureWidgetFrame(page, 'puzzle-retry');
    if (cap2 && cap2.shot.length >= 8000) {
      return handlePuzzleContent(page, cap2.shot, cap2.path, cap2.clip, attempt);
    }
    log(`Still blank (${cap2 ? cap2.shot.length : 0} bytes)`);
    return false;
  }
  return handlePuzzleContent(page, cap.shot, cap.path, cap.clip, attempt);
}

// ---------------------------------------------------------------------------
// v5 tap CAPTCHA — "Tap every creature built like this one / Same body, wings,
// legs, head and tail..."
//
// Anatomy (v5c-inline-0.js): the widget lives inline in the faucet page with a
// start GATE (".mc-gate" = "Verification Required"); clicking it fires
// GET /faucet/captcha_image which answers JSON {scene, ref} (data URLs,
// both 450x280).  The canvases sit in CLOSED shadow roots — unreachable from
// page context — so the response body (attachGeomCapture) is the only source.
// Taps are click events on the scene canvas (coords -> ca_ = "x,y;x,y";
// untap radius 18px, MAX_TAPS=8, TTL 60s from draw).  Verify (vf_) does a
// NATIVE form submit -> full page navigation to POST /faucet/verify/usdt.
// ---------------------------------------------------------------------------

async function isV5Widget(page) {
  return page.evaluate(() =>
    !!document.querySelector('.mc-gate') ||
    !!document.querySelector('[id^="st_"]') ||
    (document.body?.innerText || '').includes('Tap every creature')
  ).catch(() => false);
}

// Map canvas coords (450x280) onto the stage host rect (canvas fills host) and
// click.  Re-reads the rect every tap: ads shift layout between taps.
async function v5StageTap(page, cx, cy) {
  // Measure AND neutralize overlays in one evaluate, then click immediately:
  // the old path measured, ran a second evaluate, moved with jitter and slept
  // 40-100ms — enough for an ad resize to shift the widget ~60 canvas-px
  // (observed: intended (155,66) landed at (154,127)).  The window between
  // protocol calls is now ~5-15ms with no deliberate delay.
  const tapEval = () => page.evaluate(([tx, ty]) => {
    const st = document.querySelector('[id^="st_"]');
    if (!st) return null;
    let r = st.getBoundingClientRect();
    if (r.bottom < 4 || r.top > innerHeight - 4) {
      st.scrollIntoView({ block: 'center', inline: 'center' });
      r = st.getBoundingClientRect();
    }
    let x = r.left + (tx / 450) * r.width;
    let y = r.top + (ty / 280) * r.height;
    // An ad shift can push the stage sideways: the point then falls outside
    // the viewport and elementFromPoint/Playwright both reject it.  Recenter
    // both axes before concluding it is dead.
    if (!(x >= 2 && x <= innerWidth - 2 && y >= 2 && y <= innerHeight - 2)) {
      st.scrollIntoView({ block: 'center', inline: 'center' });
      r = st.getBoundingClientRect();
      x = r.left + (tx / 450) * r.width;
      y = r.top + (ty / 280) * r.height;
    }
    const rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    const on = x >= 2 && x <= innerWidth - 2 && y >= 2 && y <= innerHeight - 2;
    // Press-clear catches ANY top interceptor (full-screen fixed overlays AND
    // smaller ad layers) — not just the fixed/z>=1e6 class.
    const esc = !on ? 'null'
      : (typeof window.__pressClear === 'function')
        ? window.__pressClear(x, y, '[id^="st_"]') : 'no-fn';
    return { x, y, on, esc, r: rect, vw: innerWidth };
  }, [cx, cy]).catch(() => null);
  // The stage moves DYNAMICALLY mid-round (observed 10:07 and 10:39: tap0
  // lands, tap1's point goes dead ~150ms later).  On a dead point, sample
  // every 400ms and only press once two consecutive samples agree on the
  // rect — a single fixed retry can hit the same moving frame twice.
  let p = await tapEval();
  // Dead stage / destroyed context: ad reflows rebuild st_ and the rect can
  // stay [0,0,0,0] for seconds (observed 10:07/10:39/10:46 — all three bails
  // today).  Sample up to ~6s until two consecutive samples agree; a bail
  // here costs the 7min round floor, patience costs only TTL headroom, and
  // pastBailWindow() inside guarantees we never outlive the widget.
  let prevR = null;
  for (let i = 0; i < 12; i++) {
    if (p && p.esc !== 'null') {
      if (!prevR || !p.r
        || (Math.abs(p.r[0] - prevR[0]) <= 1 && Math.abs(p.r[1] - prevR[1]) <= 1)) break; // alive + settled
      prevR = p.r; // alive but just moved: remember and require one more sample
    } else if (p && p.r) {
      prevR = p.r; // dead with known rect: remember for the stability compare
    }
    // TTL exhausted mid-wait: return false so the CALLER runs the bail
    // (v5StageTap's contract is boolean — a truthy string here would read
    // as a successful press).
    if (pastBailWindow()) return false;
    await sleep(500);
    p = await tapEval();
  }
  if (!p) return false;
  // Blocked/unclear press point: do NOT press (would hit whatever covers the
  // stage — an ad click).  Return true so Phase D's per-tap ca_ verification
  // triggers its repair (re-measures) or a safe bail.
  if (p.esc && (p.esc.startsWith('blocked') || p.esc.startsWith('err') || p.esc === 'null' || p.esc === 'no-fn')) {
    if (p.esc !== 'no-fn') log(`v5 stage press blocked (${p.esc}) r=${JSON.stringify(p.r)} vw=${p.vw} — skipping press`);
    else { await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.click(p.x, p.y); }
    return true;
  }
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.click(p.x, p.y);
  return true;
}

async function handlePuzzleV5(page, attempt = 0) {
  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
  log(`Solving v5 tap challenge (attempt ${attempt + 1})`);
  if (attempt >= 4) { log('Max puzzle attempts'); return false; }

  // A Verify already fired this claim cycle: whatever widget is on screen now
  // is the platform's response — never touch it again (one Verify per claim).
  if (submitGuard.used) return bailOutOfPuzzle(page, 'v5-after-verify-reentry', false);

  await dismissSweetAlert(page);
  await page.evaluate(() => { document.querySelectorAll('[class^="cc-"]').forEach(el => el.remove()); }).catch(() => {});
  await sleep(300);

  let st = await getPageState(page);
  if (st.success || st.cooldown) return true;
  let gateClickAt = 0;

  if (!st.v5) {
    // --- Phase A: gate click = the captcha_image REQUEST = round event #1 ---
    let gate = null;
    for (let i = 0; i < 8 && !gate; i++) {
      gate = await page.evaluate(() => {
        const g = document.querySelector('.mc-gate');
        if (!g || g.hidden) return null;
        g.scrollIntoView({ block: 'center' });
        const r = g.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }).catch(() => null);
      if (gate) break;
      const s2 = await getPageState(page);
      if (s2.success || s2.cooldown) return true;
      if (s2.v5) { st = s2; break; }   // card appeared without our click
      await sleep(1000);
    }
    if (!gate && !st.v5) {
      log('v5 gate not found');
      await page.screenshot({ path: `${SHOT_DIR}/v5-no-gate-${ts()}.png`, fullPage: true }).catch(() => {});
      return 'aborted';   // nothing was opened: no event, no attempt
    }
    if (gate) {
      // Click a widget that is already on screen — the visible-widget stall
      // the user flagged.  Only BAIL-FRESH opens keep the 7min floor (their
      // reload just cost an event); clean rounds may open immediately.
      if (roundSpacingLeft() > 0 && bailFresh() && !consumeRecoveryPermit()) {
        log(`Round spacing: ${Math.round(roundSpacingLeft() / 1000)}s left (bail-fresh) — NOT opening v5 widget`);
        return 'aborted';   // gate NOT clicked: untouched page costs zero events
      }
      const esc = await ensureClickable(page, gate.x, gate.y);
      if (esc !== 'ok' && !esc.startsWith('clear')) log(`v5 gate: ${esc}`);
      gateClickAt = Date.now();
      clearWidgetClock();
      await page.mouse.click(gate.x, gate.y);
      markWidgetShown();     // also noteRoundStart(): this click fires the request
      log('Clicked v5 gate');
    }
  } else {
    markWidgetShown();       // challenge already on screen: TTL budget from now
  }
  if (pastBailWindow()) return bailOutOfPuzzle(page, 'v5 widget detection too slow');

  // --- Phase B: wait for the challenge payload (scene + ref PNGs) ---
  let ch = null;
  for (let i = 0; i < 16 && !ch; i++) {
    if (v5Challenge && Date.now() - v5Challenge.at < 120000 &&
        v5Challenge.at >= gateClickAt) ch = v5Challenge;
    if (ch) break;
    await sleep(500);
    if (i % 4 === 3) {
      const s2 = await getPageState(page);
      if (s2.success || s2.cooldown) return true;
    }
  }
  if (!ch) {
    log('v5 challenge payload not captured');
    await page.screenshot({ path: `${SHOT_DIR}/v5-no-payload-${ts()}.png`, fullPage: true }).catch(() => {});
    return bailOutOfPuzzle(page, 'v5-no-payload');
  }
  // The payload lands before the widget finishes drawing the card (image
  // decode + ~300ms gate hide — measured 1-3s after the click).  Poll for the
  // card instead of checking once, or a fast capture reads as "card gone".
  let cardReady = false;
  for (let i = 0; i < 8 && !cardReady; i++) {
    st = await getPageState(page);
    if (st.success || st.cooldown) return true;
    if (st.v5) { cardReady = true; break; }
    await sleep(400);
  }
  if (!cardReady) {
    log('v5 challenge card did not appear after capture');
    await page.screenshot({ path: `${SHOT_DIR}/v5-card-gone-${ts()}.png`, fullPage: true }).catch(() => {});
    return bailOutOfPuzzle(page, 'v5-card-gone');
  }
  // Widget readiness: an EXPIRED card or error box silently ignores every
  // stage tap (observed 10:28:35 — two taps, ca_ stayed empty).  Bail BEFORE
  // spending the solve, or wait out a transient loading spinner.
  for (let i = 0; i < 6; i++) {
    const wst = await page.evaluate(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        if (!el || el.hidden) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      return { expired: vis('[id^="ex_"]'), err: vis('[id^="eb_"]'), spinner: vis('[id^="sp_"]') };
    }).catch(() => ({ expired: false, err: false, spinner: false }));
    if (wst.expired) {
      log('v5 card expired before solve');
      return bailOutOfPuzzle(page, 'v5-expired-pre-solve');
    }
    if (wst.err) {
      log('v5 widget error box shown');
      return bailOutOfPuzzle(page, 'v5-error-shown');
    }
    if (!wst.spinner) break;
    await sleep(500);   // spinner mid-load: taps would be swallowed
  }

  // --- Phase C: solve (segment -> parallel VLM majority -> safe-union taps) ---
  if (pastBailWindow()) return bailOutOfPuzzle(page, 'v5 pre-solve past bail window');
  let out = null;
  try {
  // safe-union-cap4: identical to safe-union unless it proposes >=4 taps,
  // where it takes the arm intersection instead (analyze14: all observed >=4
  // answers were rejected; dormancy proven on official mcaptchav5 labels).
  // Revert = change this string to 'safe-union'.
  const buf = execFileSync('python3',
      [join(import.meta.dirname, 'v5solve.py'), '--files', ch.scenePath, ch.refPath, 'safe-union-cap4'],
      { encoding: 'utf8', timeout: 48000, maxBuffer: 1 << 24 });
    out = parseJSON(buf);
  } catch (e) {
    log(`v5 solve error: ${String(e.message).slice(0, 180)}`);
  }
  const nT = out && out.taps ? out.taps.length : 0;
  log(`v5 solve: ok=${!!(out && out.ok)} taps=${nT} reason=${(out && out.reason) || '-'} seg=${(out && out.seg_ms) != null ? out.seg_ms : '?'}ms vlm=${(out && out.vlm_ms) != null ? out.vlm_ms : '?'}ms wall=${(out && out.wall_ms) != null ? out.wall_ms : '?'}ms failedCells=${(out && out.failed_cells) || 0}`);
  if (pastBailWindow()) return bailOutOfPuzzle(page, 'v5 solve past bail window');
  if (!out || !out.ok || nT === 0 || nT > 8) {
    // No strict-confidence solution: NEVER Verify.  Reload is free this side
    // of the submit (no attempt recorded) and the abort backoff covers the
    // round event the open just spent.
    await page.screenshot({ path: `${SHOT_DIR}/v5-nosolve-${ts()}.png`, fullPage: true }).catch(() => {});
    return bailOutOfPuzzle(page, 'v5-solve-unsafe');
  }
  try { await page.screenshot({ path: `${SHOT_DIR}/v5-pre-verify-${Date.now()}.png` }); } catch {}

  // --- Phase D: taps — each verified against ca_ with one repair attempt ---
  // The count alone is not enough: an ad shift can land a press on a DIFFERENT
  // creature (count matches, answer wrong -> rejected Verify burns an attempt).
  // ca_ records the widget's own registered coords, so compare per tap.
  log(`v5 taps: ${JSON.stringify(out.taps)}`);
  const readAns = () => page.evaluate(() =>
    document.querySelector('[id^="ca_"], [name="captcha_answer"]')?.value || ''
  ).catch(() => '');
  const parseAns = v => v
    ? v.split(';').filter(Boolean).map(s => s.split(',').map(n => parseInt(n, 10)))
    : [];
  const near = (c, ix, iy) => Math.abs(c[0] - ix) <= 8 && Math.abs(c[1] - iy) <= 8;
  for (let k = 0; k < out.taps.length; k++) {
    if (pastBailWindow()) return bailOutOfPuzzle(page, 'v5 ttl during taps');
    const [ix, iy] = out.taps[k];
    if (!(await v5StageTap(page, ix, iy))) return bailOutOfPuzzle(page, 'v5 stage gone');
    await sleep(70 + Math.random() * 60);
    let coords = parseAns(await readAns());
    if (coords.length !== k + 1 || !near(coords[coords.length - 1], ix, iy)) {
      log(`v5 tap ${k} landed off-target: ${JSON.stringify(coords)} — repairing`);
      // Repair once: untap any wrong marker (same coords -> distance 0 -> untap),
      // then re-tap with a freshly measured rect.
      if (coords.length > k) {
        const w = coords[coords.length - 1];
        if (!(await v5StageTap(page, w[0], w[1]))) return bailOutOfPuzzle(page, 'v5 stage gone untap');
        await sleep(70);
      }
      if (pastBailWindow()) return bailOutOfPuzzle(page, 'v5 ttl during tap repair');
      if (!(await v5StageTap(page, ix, iy))) return bailOutOfPuzzle(page, 'v5 stage gone retap');
      await sleep(90);
      coords = parseAns(await readAns());
      if (coords.length !== k + 1 || !near(coords[coords.length - 1], ix, iy)) {
        const under = await page.evaluate(([tx, ty]) => {
          const st = document.querySelector('[id^="st_"]');
          if (!st) return 'no-st';
          const r = st.getBoundingClientRect();
          const x = r.left + (tx / 450) * r.width, y = r.top + (ty / 280) * r.height;
          const el = document.elementFromPoint(x, y);
          return el ? `${el.tagName}#${el.id || '-'}.${(typeof el.className === 'string' ? el.className : '').slice(0, 40)}` : 'null';
        }, [ix, iy]).catch(() => 'eval-failed');
        log(`v5 tap${k} repair failed — ca_=${JSON.stringify(coords)} under=${under}`);
        await page.screenshot({ path: `${SHOT_DIR}/v5-tapoff-${ts()}.png`, fullPage: true }).catch(() => {});
        return bailOutOfPuzzle(page, `v5 tap${k} off-target after repair ${JSON.stringify(coords)}`);
      }
      log(`v5 tap ${k} repaired: ${JSON.stringify(coords[coords.length - 1])}`);
    }
    await sleep(60 + Math.random() * 90);
  }
  await sleep(350);
  // Closed loop: the widget rewrites ca_ = "x,y;x,y" on every tap change.
  const ans = await readAns();
  const landed = parseAns(ans);
  const nAns = landed.length;
  log(`v5 taps landed: "${ans}" (${nAns}/${out.taps.length})`);
  // Every intended tap must have a landed marker within 8px (order-independent).
  const unmatched = out.taps.filter(t => !landed.some(c => near(c, t[0], t[1])));
  if (nAns !== out.taps.length || unmatched.length) {
    // A silent tap miss would make Verify a guaranteed burn — bail instead.
    await page.screenshot({ path: `${SHOT_DIR}/v5-tapmismatch-${ts()}.png`, fullPage: true }).catch(() => {});
    return bailOutOfPuzzle(page, `v5 tap mismatch ${nAns}!=${out.taps.length} unmatched=${unmatched.length}`);
  }

  if (dryRunMode) {
    await sleep(600);
    await page.screenshot({ path: `${SHOT_DIR}/v5-dryrun-${ts()}.png`, fullPage: true }).catch(() => {});
    log('DRY-RUN: taps landed and ca_ confirmed — stopping BEFORE Verify');
    return 'dryrun';   // no reload: only the gate click spent a round event
  }

  // --- Phase E: ONE Verify per claim cycle ---
  if (pastBailWindow()) return bailOutOfPuzzle(page, 'past-bail-window-verify');
  if (submitGuard.used) {
    await bailOutOfPuzzle(page, 'second-verify-blocked');
    return false;
  }
  await sleep(600);   // let the marker DOM write settle

  // Measure + clear the press point in ONE evaluate, press immediately, then
  // read the widget's OWN taken-signal (11:26 no-submit: the click never
  // reached btnVf or its guard early-returned — both leave disabled=false,
  // and form.submit() is only reachable from that handler, so disabled=false
  // after the press proves NO attempt exists and a re-measured retry is safe).
  const readTaken = () => page.evaluate(() => {
    const b = document.querySelector('[id^="vf_"]');
    if (!b) return null;                       // gone => probably navigating
    return b.disabled || String(b.textContent || '').indexOf('Verifying') !== -1;
  }).catch(() => null);
  const clickVf = () => page.evaluate(() => {
    const b = document.querySelector('[id^="vf_"]');
    if (!b || b.disabled) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const esc = (typeof window.__pressClear === 'function')
      ? window.__pressClear(x, y, '[id^="vf_"]') : 'no-fn';
    return { x, y, esc };
  }).catch(() => null);

  const clrOk = (p) => p && (p.esc === 'clear' || p.esc === 'cleared' || p.esc === 'no-fn');
  let vfRect = await clickVf();
  if (vfRect && !clrOk(vfRect)) vfRect = await clickVf();   // 2nd measure picks up the neutralization
  if (!clrOk(vfRect)) {
    log(`v5 Verify button unusable (esc=${vfRect ? vfRect.esc : 'absent'}) — not submitting`);
    await page.screenshot({ path: `${SHOT_DIR}/v5-noverify-${ts()}.png`, fullPage: true }).catch(() => {});
    return bailOutOfPuzzle(page, 'v5-verify-unavailable');
  }
  const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
  submitGuard.used = true;   // from here: no other verify path may run
  await page.mouse.click(vfRect.x, vfRect.y);
  log('Clicked v5 Verify');
  const takenOnce = async () => {
    let t = await readTaken();
    if (t === null) t = await readTaken();
    return t;   // null twice => page mid-unload; treat as taken (conservative)
  };
  let taken = await takenOnce();
  if (taken === null) { log('v5 Verify taken-state unknown (page unloading) — treating as submitted'); taken = true; }

  if (!taken) {
    // Provably no attempt sent — dump the guard the widget bailed on, then
    // re-measure (ads shift) and press exactly once more.
    const why = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const b = q('[id^="vf_"]'), ex = q('[id^="ex_"]'), sp = q('[id^="sp_"]');
      const ca = q('[id^="ca_"], [name="captcha_answer"]');
      return JSON.stringify({
        btn: b ? `${b.disabled ? 'disabled' : 'enabled'} ${(b.textContent || '').trim().slice(0, 14)}` : 'absent',
        expired: !!(ex && !ex.hidden),
        spinner: !!(sp && sp.style.display !== 'none'),
        taps: ca ? (ca.value || '').split(';').filter(Boolean).length : -1,
      });
    }).catch(() => '?');
    log(`v5 Verify not taken (${why}) — re-measuring and pressing once more`);
    const again = await clickVf();
    if (clrOk(again)) {
      await page.mouse.click(again.x, again.y);
      taken = await takenOnce();
      if (taken === null) taken = true;
    }
    if (!taken) {
      log('v5 Verify press not accepted after retry — no attempt sent');
      await page.screenshot({ path: `${SHOT_DIR}/v5-verify-nosubmit-${ts()}.png`, fullPage: true }).catch(() => {});
      return bailOutOfPuzzle(page, 'v5-verify-not-submitted');   // ret 'aborted'
    }
  }
  const nav = await navPromise;
  await sleep(2000);
  if (!nav) log('v5 Verify taken (btn disabled) but no navigation within 15s — polling before concluding');

  // --- Phase F: result poll (same semantics as the legacy post-verify) ---
  let submitted = taken || !!nav;   // taken => form.submit() dispatched
  for (let i = 0; i < 12; i++) {
    const after = await getPageState(page);
    if (after.navError) { await sleep(1500); continue; }
    if (after.success) { log('v5 solved — claim successful!'); return true; }
    if (after.cooldown) { log('Cooldown after v5 — claim likely succeeded'); return true; }
    if (after.verificationFailed) {
      await dismissSweetAlert(page);
      await page.screenshot({ path: `${SHOT_DIR}/v5-verify-failed-${ts()}.png`, fullPage: true }).catch(() => {});
      log('Site said: verification failed — account state now needs a reset');
      return bailOutOfPuzzle(page, 'verification-failed', false);
    }
    if (after.captchaError) {
      await dismissSweetAlert(page);
      return bailOutOfPuzzle(page, 'captcha-rejected', false);
    }
    if (after.v5 && !after.verification) {
      submitted = true;      // fresh card served -> platform responded to us
      await dismissSweetAlert(page);
      await page.screenshot({ path: `${SHOT_DIR}/v5-fresh-after-verify-${ts()}.png`, fullPage: true }).catch(() => {});
      log('Fresh v5 card after Verify — rejected attempt');
      return bailOutOfPuzzle(page, 'fresh-puzzle-after-verify', false);
    }
    if (after.verification && !after.success && i >= 4) break;   // gate back, no verdict text
    await sleep(2000);
  }

  if (!submitted) {
    // Safety net (unreachable via the taken path): native form.submit always
    // navigates, so no navigation plus no taken-signal = no attempt.
    log('v5 Verify did not submit — treating as no-attempt');
    await page.screenshot({ path: `${SHOT_DIR}/v5-verify-nosubmit-${ts()}.png`, fullPage: true }).catch(() => {});
    return bailOutOfPuzzle(page, 'v5-verify-not-submitted');   // ret 'aborted'
  }
  const mid = await getPageState(page);
  if (mid.success || mid.cooldown) return true;
  if (mid.verification && submitGuard.used) return bailOutOfPuzzle(page, 'verify-unconfirmed', false);
  await page.screenshot({ path: `${SHOT_DIR}/v5-after-verify-${ts()}.png`, fullPage: true }).catch(() => {});
  log(`After v5 verify: success=${mid.success} cooldown=${mid.cooldown} v5=${mid.v5} verif=${mid.verification}`);
  if (attempt < 3) return handlePuzzleV5(page, attempt + 1);
  return false;
}

function findPiecePy(path) {
  try {
    const out = execFileSync('python3', [join(import.meta.dirname, 'find_piece.py'), path], { encoding: 'utf8', timeout: 15000 }).trim();
    if (!out || out === 'null') return null;
    return JSON.parse(out);
  } catch (e) {
    log(`find_piece error: ${e.message.slice(0, 100)}`);
    return null;
  }
}

// The screenshot covers the widget HOST box (border+padding included); the
// canvas sits inset inside it.  Map that to image px so the chain detector
// scales/offsets the sprite template correctly.  null => "assume the whole
// image is the canvas" (what find_hole.py has always done).
function canvasRectFor(clip, t) {
  if (!clip || !t || !(t.canvasW > 50) || !(t.canvasH > 50)) return null;
  const x = (clip.x - t.hostX) + t.insetL;
  const y = (clip.y - t.hostY) + t.insetT;
  if (x < -16 || y < -16) return null;
  if (x + t.canvasW > clip.width + 16 || y + t.canvasH > clip.height + 16) return null;
  return `${x.toFixed(1)},${y.toFixed(1)},${t.canvasW.toFixed(1)},${t.canvasH.toFixed(1)}`;
}

function chainDetect(img, rect, g) {
  const argv = ['python3', join(import.meta.dirname, 'find_chain.py'), img,
    '--sprite', g.spritePath, '--geom', `${g.x},${g.y}`];
  if (rect) argv.push('--rect', rect);
  try {
    const out = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 }).trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch (e) {
    log(`find_chain error on ${img.split('/').pop()}: ${e.message.slice(0, 120)}`);
    return null;
  }
}

// The captured background IS the canvas (450x280 == canvas coords), but every
// downstream step — gate maths against vision, drag targets, clipToCanvas —
// works in screenshot/clip px, so translate the reading through the canvas
// rect we computed inside the clip.
function canvasDetToClip(d, rect) {
  if (!d || !rect) return d;
  const [rx, ry, rw, rh] = rect.split(',').map(Number);
  if (!(rw > 0) || !(rh > 0)) return d;
  const sx = rw / CANVAS_W, sy = rh / CANVAS_H;
  const mx = (v) => (v == null ? v : Math.round((rx + v * sx) * 10) / 10);
  const my = (v) => (v == null ? v : Math.round((ry + v * sy) * 10) / 10);
  const out = { ...d, src: 'bg' };
  out.targetX = mx(d.targetX);
  out.targetY = my(d.targetY);
  for (const k of ['pieceX', 'grabX', 'grabAltX', 'chainX']) out[k] = mx(d[k]);
  for (const k of ['pieceY', 'grabY', 'grabAltY', 'chainY']) out[k] = my(d[k]);
  out.cands = (d.cands || []).map(c => ({ ...c, x: mx(c.x), y: my(c.y) }));
  return out;
}

// Chain detector first (dash chain tracing the hole, matched with the piece's
// own silhouette from X-Captcha-Piece).  Its z/score semantics are honest
// matched-filter statistics, unlike find_hole.py's morphological guesses, so
// a weak chain read means WEAK — we never silently upgrade it with the
// flakier detector; the confidence gate decides whether it is usable.
function findHolePy(path, rect, bgPath) {
  const g = freshGeom();
  if (g && g.spritePath) {
    const ok = (d) => d && d.targetX != null && Array.isArray(d.cands) && d.cands.length > 0;
    if (bgPath && rect) {
      const bg = canvasDetToClip(chainDetect(bgPath, null, g), rect);
      if (ok(bg)) {
        bg.detector = 'chain';
        bg.input = 'bg';
        return bg;
      }
      log(`find_chain(bg) weak: z=${bg && bg.z} target=${bg && bg.targetX},${bg && bg.targetY}`);
    }
    const shot = chainDetect(path, rect, g);
    if (ok(shot)) {
      shot.detector = 'chain';
      shot.input = 'shot';
      return shot;
    }
    log(`find_chain(shot) weak: z=${shot && shot.z} target=${shot && shot.targetX},${shot && shot.targetY}`);
    return null;
  }
  try {
    const out = execFileSync('python3', [join(import.meta.dirname, 'find_hole.py'), path], { encoding: 'utf8', timeout: 30000 }).trim();
    if (!out || out === 'null') return null;
    const d = JSON.parse(out);
    if (d) d.detector = 'morph';
    return d;
  } catch (e) {
    log(`find_hole error: ${e.message.slice(0, 100)}`);
    return null;
  }
}

// Pure consensus + confidence gate.  Extracted so the read-only rehearsal tool
// (verify_chain.mjs) can run the *identical* decision logic the bot uses —
// what we rehearse is what we submit.
//   chain-clear  dash-chain matched filter is sharp AND corroborated by an
//                enclosed interior in the piece's shape; leads, vision only
//                corroborates (it has been seen 13-145px off)
//   agree        vision + CV point at the same spot (<=30px) -> submit
//   py-clear     morph detector only (no sprite), CV winner clearly ahead
//   bail         everything else; the vision self-check runs in the caller
function consensusGate(holeDet, vision, w, h) {
  const pieceX = (holeDet && holeDet.pieceX != null) ? holeDet.pieceX
    : (vision && vision.pieceX != null) ? vision.pieceX : w / 2;
  const pieceY = (holeDet && holeDet.pieceY != null) ? holeDet.pieceY
    : (vision && vision.pieceY != null) ? vision.pieceY : h / 2;
  const grabX = (holeDet && holeDet.grabX != null) ? holeDet.grabX : pieceX;
  const grabY = (holeDet && holeDet.grabY != null) ? holeDet.grabY : pieceY;
  const grabAltX = (holeDet && holeDet.grabAltX != null) ? holeDet.grabAltX : grabX;
  const grabAltY = (holeDet && holeDet.grabAltY != null) ? holeDet.grabAltY : grabY;

  const pyBest = (holeDet && holeDet.cands && holeDet.cands.length) ? holeDet.cands[0] : null;
  const pyCands = (holeDet && holeDet.cands) ? holeDet.cands : [];
  const visionOnBoard = vision && vision.targetX != null && vision.targetY != null
    && Math.hypot(vision.targetX - pieceX, vision.targetY - pieceY) >= 15;
  const agreeDist = (pyBest && visionOnBoard)
    ? Math.hypot(pyBest.x - vision.targetX, pyBest.y - vision.targetY)
    : null;
  const pyPd = holeDet && holeDet.ptdist != null ? holeDet.ptdist : 1;
  const pyMargin = (pyCands.length > 1 && pyCands[0].score > 0)
    ? pyCands[1].score / pyCands[0].score : null;
  log(`Consensus: pyBest=${pyBest ? `(${pyBest.x},${pyBest.y}) pd=${pyBest.ptdist}` : 'none'} vision=${visionOnBoard ? `(${Math.round(vision.targetX)},${Math.round(vision.targetY)})` : 'none'} dist=${agreeDist != null ? agreeDist.toFixed(0) : 'n/a'} margin=${pyMargin != null ? pyMargin.toFixed(2) : 'n/a'}`);

  // ---- Confidence gate -------------------------------------------------
  // A wrong Verify is a brand-new puzzle AND counts toward the 3-strike ban,
  // so we only ever submit when the read is unambiguous. Anything else is
  // abandoned with a reload (no attempt recorded) instead of guessed at.
  const PY_PD_MAX = 0.10;     // observed ~0.078-0.090 on real puzzles
  const PY_MARGIN_MIN = 1.2;  // best score vs runner-up
  const chainMode = !!holeDet && holeDet.detector === 'chain';
  // Chain thresholds calibrated on ALL 16 captured samples (5 truth bgs +
  // 3 verify bgs + 8 widget shots, table in /tmp/onlyfaucet-shots/gate-table.json):
  //   correct reads  z 5.16-7.98 / margin 1.33-2.15 / pd 0.059-0.079
  //   wrong reads    z 3.40-4.74  / margin 1.00-1.65 / pd 0.083-0.099
  // Every wrong read fails z >= 5 OR margin >= 1.25 (best wrong: T3-w z 3.7
  // m 1.04; T4-w/T5-w z 4.7/4.74 but those turned out correct anyway), and
  // every correct read clears both -> 10/10 pass, 0/6 wrong pass.
  //   z >= 5 <=> ptdist <= 0.087, so the pd check is implied.
  // The earlier third clause (support >= 2 && iou0 >= 0.35 for z < 7) was
  // dropped: the enclosed-interior signal is flaky (V3-bg correct read had
  // support 1 / iou0 0.226 -> needless bail) while cover/coverGap do not
  // separate either (wrong widget reads score HIGHER cover 0.77-0.86 than
  // correct bg reads 0.69-0.77).  support/iou0/cover stay in the log as
  // diagnostics only.
  // cover (tolerant outline coverage) now ALSO gates: it does not separate
  // right from wrong — 0.69-0.77 correct vs 0.77-0.86 wrong — but it separates
  // a real measurement from a degenerate one.  Every healthy read on either
  // widget theme scores >= 0.69; a broken dash mask collapses it to ~0.02
  // while z goes crazy (z=33.97 m=10.1 once cleared this gate and dragged to
  // a noise peak the site rejected).  0.5 sits far below every real read and
  // far above every broken one.
  const CHAIN_Z_MIN = 5.0;
  const CHAIN_MARGIN_MIN = 1.25;
  const CHAIN_COVER_MIN = 0.5;
  const chainClear = chainMode && holeDet.z != null && holeDet.z >= CHAIN_Z_MIN
    && pyMargin != null && pyMargin >= CHAIN_MARGIN_MIN
    && holeDet.cover != null && holeDet.cover >= CHAIN_COVER_MIN;
  const pyClear = !chainMode && !!pyBest && pyPd <= PY_PD_MAX
    && pyMargin != null && pyMargin >= PY_MARGIN_MIN;

  let gate = 'bail';
  let primary = null;
  if (chainClear) {
    // The chain read leads: on the captured samples it sits on the dash chain
    // (silhouette-outline coverage 0.91-0.98, i.e. 6-8 sigma over random
    // placements) while vision was observed 13px and even 145px off — so a
    // clear chain is used as-is and never averaged with vision.
    gate = 'chain-clear';
    primary = { x: pyBest.x, y: pyBest.y, src: `chain${holeDet.z}m${pyMargin.toFixed(1)}` };
  } else if (pyBest && visionOnBoard && agreeDist <= 30
    && (!chainMode || (holeDet.z != null && holeDet.z >= 4 && pyMargin != null && pyMargin >= 1.15))) {
    gate = 'agree';
    primary = { x: (vision.targetX + pyBest.x) / 2, y: (vision.targetY + pyBest.y) / 2, src: `agree${agreeDist.toFixed(0)}` };
  } else if (pyBest && visionOnBoard) {
    gate = 'conflict'; // both saw a target, they disagree: one is a decoy
  } else if (pyClear) {
    gate = 'py-clear';
    primary = { x: pyBest.x, y: pyBest.y, src: `py${pyBest.score}` };
  }

  const hd = holeDet || {};
  log(`Gate: ${gate} det=${hd.detector || 'none'}/${hd.input || '-'} z=${hd.z ?? 'n/a'} pd=${pyPd.toFixed(3)} margin=${pyMargin != null ? pyMargin.toFixed(2) : 'n/a'} sup=${hd.support ?? 'n/a'} iou=${hd.iou0 ?? 'n/a'} agree=${agreeDist != null ? agreeDist.toFixed(0) : 'n/a'}`);
  return {
    pieceX, pieceY, grabX, grabY, grabAltX, grabAltY,
    pyBest, pyCands, visionOnBoard, agreeDist, pyPd, pyMargin,
    chainClear, pyClear, gate, primary,
  };
}

async function handlePuzzleContent(page, shot, shotPath, clip, attempt) {
  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
  let w = Math.round(clip.width);
  let h = Math.round(clip.height);
  log(`Puzzle box clip: ${JSON.stringify(clip)} widgetAge=${widgetAgeMs()}ms`);
  if (pastBailWindow()) return bailOutOfPuzzle(page, 'widget-clock-early');
  // Re-entering after a Verify already fired this claim cycle: never submit a
  // second attempt, just clear the widget and report the cycle as failed.
  if (submitGuard.used) {
    await bailOutOfPuzzle(page, 'reentered-after-verify');
    return false;
  }
  // Time left before the widget force-fails; used to skip expensive retries
  // that would push us past the bail window.
  const msLeft = () => Math.max(0, BAIL_MS - widgetAgeMs());

  let tr = null;
  try { tr = await getCanvasTransform(page); } catch (e) { tr = null; }
  let rect = canvasRectFor(clip, tr);
  const geomNow = freshGeom();
  const bgPath = await freshBgPath(page, geomNow ? geomNow.at : null);
  log(`canvas rect in shot: ${rect || 'unknown (full-image mapping)'} bg=${bgPath || 'none'}`);

  // Re-capture with a fresh measure whenever the layout may have moved since
  // this frame was taken.  Keeps clip/w/h/rect in lockstep with what the new
  // frame actually contains — a stale rect maps find_hole candidates into the
  // wrong canvas coordinates (and would skew clipToCanvas at drag time).
  const refreshFrame = async (tag) => {
    const cap = await captureWidgetFrame(page, tag);
    if (!cap) return null;
    clip = cap.clip;
    w = Math.round(clip.width);
    h = Math.round(clip.height);
    try { tr = await getCanvasTransform(page); } catch (e) { tr = null; }
    rect = canvasRectFor(clip, tr);
    log(`frame refreshed (${tag}): clip=${JSON.stringify(clip)} rect=${rect}`);
    return cap;
  };

  // CV first: it costs 2-4s vs vision's 13-16s, and it alone decides whether
  // vision is needed at all (see below).
  let holeDet = findHolePy(shotPath, rect, bgPath);
  log(`find_hole: ${JSON.stringify(holeDet)}`);
  let pyHasTarget = holeDet && holeDet.targetX != null && holeDet.cands && holeDet.cands.length > 0;

  // Vision-on-demand: the chain-clear branch of consensusGate never consults
  // vision — the gate was calibrated on all 16 samples that way — and every
  // vision call burns 13-16s of the widget's 50s clock, which is what used to
  // leave the drag racing forceFail.  So a decisive chain read skips vision
  // entirely.  Everything else (incl. morph-mode py-clear, where the
  // agree/conflict branches still interleave with vision) pays for the
  // cross-check exactly as before.
  let vision = null;
  let cons = consensusGate(holeDet, null, w, h);
  const needVision = !cons.chainClear;
  if (needVision) {
    // Vision cross-check before trusting a ranking. One retry max: the widget
    // clock matters more than a third try.
    for (let v = 0; v < 2 && !pastBailWindow() && (v === 0 || msLeft() > 12000); v++) {
      try {
        vision = await analyzePuzzle(shot, w, h);
        log(`Vision: ${JSON.stringify(vision)}`);
        if (vision && vision.targetX != null && vision.targetY != null) break;
      } catch (e) {
        log(`Vision error: ${e.message.slice(0, 120)}`);
        await sleep(1200);
      }
    }
    cons = consensusGate(holeDet, vision, w, h);
  } else {
    log(`CV read decisive (${cons.gate}) — vision skipped, drag starts ~13s earlier`);
  }

  // Re-screenshot + re-detect if piece/candidates missing (mid-render)
  const visionHasTarget = vision && vision.targetX != null && vision.targetY != null;
  if ((!pyHasTarget || (needVision && !visionHasTarget)) && attempt < 3 && msLeft() > 18000) {
    log('Detection weak — waiting and re-screenshotting...');
    await sleep(1500);
    const cap2 = await refreshFrame('puzzle-redet');
    if (cap2 && cap2.shot.length >= 8000) {
      const shotPath2 = cap2.path;
      const shot2 = cap2.shot;
      const py2 = Promise.resolve().then(() => findHolePy(shotPath2, rect, bgPath));
      // vision is throttled; only re-run it if the first pass found nothing
      // AND the gate actually wanted a vision cross-check (a decisive CV read
      // must never pay the 13-16s vision cost).
      if (needVision && !visionHasTarget && msLeft() > 14000) {
        try {
          const v2 = await analyzePuzzle(shot2, w, h);
          if (v2 && v2.targetX != null && v2.targetY != null) { vision = v2; log(`Vision retry: ${JSON.stringify(v2)}`); }
        } catch (e) {
          log(`Vision retry error: ${e.message.slice(0, 120)}`);
        }
      }
      holeDet = await py2;
      log(`find_hole retry: ${JSON.stringify(holeDet)}`);
      shot = shot2;
      shotPath = shotPath2;
      pyHasTarget = holeDet && holeDet.targetX != null && holeDet.cands && holeDet.cands.length > 0;
      cons = consensusGate(holeDet, vision, w, h);
    }
  }

  const { pieceX, pieceY, grabX, grabY, grabAltX, grabAltY, pyBest, pyCands,
    visionOnBoard } = cons;
  let { gate, primary } = cons;

  // Last resort: CV unreadable but vision saw a target — make vision repeat
  // itself before trusting it (a single hallucinated pass must not submit).
  if (gate === 'bail' && visionOnBoard && msLeft() > 15000) {
    gate = 'vision-only';
    try {
      const v2 = await analyzePuzzle(shot, w, h);
      if (v2 && v2.targetX != null && v2.targetY != null) {
        const d2 = Math.hypot(v2.targetX - vision.targetX, v2.targetY - vision.targetY);
        log(`Vision self-check: repeat=${d2.toFixed(0)}px`);
        if (d2 <= 25) {
          gate = 'vision-agree';
          primary = { x: (vision.targetX + v2.targetX) / 2, y: (vision.targetY + v2.targetY) / 2, src: `vagree${d2.toFixed(0)}` };
        }
      }
    } catch (e) {
      log(`Vision self-check error: ${e.message.slice(0, 100)}`);
    }
    log(`Gate: ${gate} (after vision self-check)`);
  }
  if (pastBailWindow()) return bailOutOfPuzzle(page, 'past-bail-window');

  const candidates = [];
  const pushCand = (x, y, src) => {
    if (Math.hypot(x - pieceX, y - pieceY) < 15) return false;
    if (candidates.some(c2 => Math.hypot(c2.x - x, c2.y - y) < 25)) return false;
    candidates.push({ x, y, src });
    return true;
  };

  if (!primary) {
    // Ambiguous read: reload rather than spend an attempt on a coin flip.
    return bailOutOfPuzzle(page, `low-confidence:${gate}`);
  }
  if (!pushCand(primary.x, primary.y, primary.src)) {
    return bailOutOfPuzzle(page, `degenerate-target:${gate}`);
  }
  // CV alternatives only matter as same-puzzle drop-miss fallbacks.
  for (const c of pyCands) pushCand(c.x, c.y, `py${c.score}`);

  // First pick must be correct (verify-reject = brand-new puzzle).
  // 4 attempts only matter for drop-miss recovery on the SAME puzzle.
  const maxTry = Math.min(candidates.length, 4);
  const retried = new Set();
  const grabOpts = [
    { x: grabX, y: grabY, tag: 'grab' },
    { x: grabAltX, y: grabAltY, tag: 'alt' },
    { x: pieceX, y: pieceY, tag: 'ctr' },
  ];
  let grabIdx = 0;
  let emptyFails = 0;
  const maxEmptyFails = 6;
  let curPieceX = pieceX, curPieceY = pieceY;
  let curGrab = grabOpts[0];

  async function redetectPiece(afterFail) {
    log(`Re-detecting piece after ${afterFail}...`);
    const capR = await refreshFrame('puzzle-redet');
    if (!capR || capR.shot.length < 8000) return false;
    const d = findHolePy(capR.path, rect, bgPath);
    if (!d || d.pieceX == null) return false;
    curPieceX = d.pieceX;
    curPieceY = d.pieceY;
    const gxs = [d.grabX, d.grabAltX].filter(v => v != null);
    const gys = [d.grabY, d.grabAltY].filter(v => v != null);
    const g0 = { x: gxs[0] ?? curPieceX, y: gys[0] ?? curPieceY, tag: 'regrab' };
    const g1 = { x: gxs[1] ?? curPieceX, y: gys[1] ?? curPieceY, tag: 'realt' };
    grabOpts.length = 0;
    grabOpts.push(g0, g1, { x: curPieceX, y: curPieceY, tag: 'rectr' });
    grabIdx = 0;
    curGrab = grabOpts[0];
    // (curOffX/curOffY from an older grab-offset scheme were removed: they
    // were assigned but never declared nor read — in ESM strict mode the
    // assignment threw ReferenceError the first time re-detect ran.)
    log(`Piece re-detected at (${curPieceX},${curPieceY}) grab=${curGrab.tag}(${curGrab.x},${curGrab.y})`);
    return true;
  }

  // --- drag helpers -----------------------------------------------------
  // The whole drag path works in canvas coords (450x280, the same space
  // captcha_answer reports); a freshly-read host box only places the mouse.
  const fallbackTransform = () => ({
    hostX: clip.x, hostY: clip.y, hostW: clip.width, hostH: clip.height,
    insetL: 0, insetT: 0, insetR: 0, insetB: 0,
    canvasX: clip.x, canvasY: clip.y, canvasW: clip.width, canvasH: clip.height,
  });

  async function readAnswer() {
    // Direct field read: getPageState walks the whole DOM + innerText, which
    // is wasted latency between drag and drop-check (called 1-3x per candidate).
    const v = await page.evaluate(() =>
      document.querySelector('[name="captcha_answer"]')?.value || ''
    ).catch(() => '');
    const m = v.match(/^(-?\d+)\s*,\s*(-?\d+)$/);
    if (!m) return null;
    return { x: +m[1], y: +m[2], raw: v };
  }

  async function resetPuzzle() {
    await page.evaluate(() => {
      const b = document.querySelector('[id^="rb_btn_"]');
      if (b) b.click();
    }).catch(() => {});
    await sleep(700);
  }

  // Empty/desynced answer: reset the widget and pick a different grab point,
  // re-detecting the piece once the built-in options are exhausted.
  async function recoverGrab(reason) {
    await resetPuzzle();
    if (grabIdx < grabOpts.length - 1) grabIdx++;
    else if (await redetectPiece(reason)) grabIdx = 0;
    curGrab = grabOpts[Math.min(grabIdx, grabOpts.length - 1)];
    log(`Recover[${reason}]: grab -> ${curGrab.tag}(${curGrab.x},${curGrab.y})`);
  }

  const DROP_OK = 6;     // canvas px — clean drop, Verify away
  const DROP_FAR = 15;   // sloppier than this: nudge done twice already, re-detect

  for (let ci = 0; ci < maxTry; ci++) {
    const cand = candidates[ci];
    if (pastBailWindow()) return bailOutOfPuzzle(page, 'past-bail-window-drag');

    // Fresh host box: only used to place the mouse (ads shift layout).
    const tr = (await getCanvasTransform(page)) || fallbackTransform();
    // Detection coords are relative to the captured box, so convert with the
    // capture-time origin — a page shift must not skew the target.
    const relT = { ...tr, hostX: clip.x, hostY: clip.y };
    const candC = clipToCanvas(relT, clip, cand.x, cand.y);
    const pieceC = clipToCanvas(relT, clip, curPieceX, curPieceY);
    let grabC = clipToCanvas(relT, clip, curGrab.x, curGrab.y);
    // The server's own piece center (X-Captcha-Piece) is exact: prefer it when
    // it agrees with the CV detection.
    const geomNow = freshGeom();
    if (geomNow && Math.hypot(geomNow.x - pieceC.x, geomNow.y - pieceC.y) <= 30) {
      grabC = { x: geomNow.x, y: geomNow.y };
      log(`Grab from captcha_image geometry (${geomNow.x},${geomNow.y})`);
    }
    log(`Drag [${cand.src}/${curGrab.tag}] grab(${grabC.x.toFixed(0)},${grabC.y.toFixed(0)}) -> target(${candC.x.toFixed(0)},${candC.y.toFixed(0)}) [canvas]`);

    await dragCanvas(page, tr, grabC, candC);
    log('Drag completed');

    let ans = await readAnswer();
    log(`captcha_answer after drag: "${ans ? ans.raw : ''}"`);
    let ansLost = false;
    if (ans) {
      // Closed loop: captcha_answer IS the drop position in canvas coords, so
      // nudge the piece from where it actually landed onto the target instead
      // of guessing grab offsets.
      for (let k = 0; k < 2; k++) {
        // A nudge is a full extra drag — never start one inside the bail
        // window, or forceFail (50s) lands mid-sequence.
        if (pastBailWindow()) return bailOutOfPuzzle(page, 'past-bail-window-nudge');
        const err = Math.hypot(ans.x - candC.x, ans.y - candC.y);
        log(`Drop check: answer(${ans.x},${ans.y}) target(${candC.x.toFixed(0)},${candC.y.toFixed(0)}) err=${err.toFixed(1)}px`);
        if (err <= DROP_OK) break;
        log(`Correcting drop (${k + 1}/2)`);
        await dragCanvas(page, tr, { x: ans.x, y: ans.y }, candC);
        const a2 = await readAnswer();
        if (!a2) { ansLost = true; break; }
        ans = a2;
      }
    }

    if (!ans || ansLost) {
      emptyFails++;
      log(`Answer not recorded (${emptyFails}/${maxEmptyFails})`);
      if (emptyFails >= maxEmptyFails) {
        log('Too many empty answers — abandon candidate');
        continue;
      }
      await recoverGrab('empty answer');
      if (!retried.has(ci)) {
        retried.add(ci);
        ci--;
      }
      continue;
    }

    const dropErr = Math.hypot(ans.x - candC.x, ans.y - candC.y);
    if (dropErr > DROP_FAR) {
      log(`Drop still ${dropErr.toFixed(0)}px off — reset, re-detect, retry candidate`);
      await resetPuzzle();
      await redetectPiece('drop miss');
      grabIdx = 0;
      curGrab = grabOpts[0];
      if (!retried.has(ci)) {
        retried.add(ci);
        ci--; // retry same index with fresh piece/grab
      }
      continue;
    }
    log(`Drop accepted: err=${dropErr.toFixed(1)}px`);
    // Visual ground truth: the piece's resting place vs the hole, BEFORE the
    // click (verify-failed shots are all post-reload resets).
    try { await page.screenshot({ path: `${SHOT_DIR}/pre-verify-${Date.now()}.png` }); } catch {}

    // Never Verify inside the force-fail window: a reload here is free, a
    // submit that gets rejected mid-countdown is not.
    if (pastBailWindow()) return bailOutOfPuzzle(page, 'past-bail-window-verify');

    // One Verify per claim cycle — a second one would be a second real attempt.
    if (submitGuard.used) {
      await bailOutOfPuzzle(page, 'second-verify-blocked');
      return false; // count it: otherwise an unclear outcome loops forever
    }

    // The widget commits the drop asynchronously (endDrag -> answer field ->
    // server pickup).  Clicking Verify in the same instant races that commit
    // and the platform answers "verification failed" even for a perfect
    // drop (user-observed).  Give it a beat before reading state/submitting.
    await sleep(700);

    // Click Verify Selection — may navigate
    const st = await getPageState(page);
    submitGuard.used = true;
    // Capture the verify submit's raw request/response: the server's exact
    // verdict (wrong answer vs stale/invalid token vs bot flag) is otherwise
    // unrecoverable — the modal only says "Verification failed".
    if (!page.__ofVerifyHook) {
      page.__ofVerifyHook = true;
      page.on('response', async (res) => {
        try {
          const req = res.request();
          const u = res.url();
          const isAsset = /\.(png|jpe?g|gif|css|js|woff2?|svg|webp)(\?|$)/i.test(u);
          if (isAsset) return;
          // Same-origin activity only (plus any captcha/verify URL): third-party
          // ad/analytics/cdn-cgi POSTs bury the two lines that matter.
          const sameOrigin = u.startsWith(`${BASE_URL}/`);
          const interesting = sameOrigin
            ? (req.method() === 'POST' && !/\/cdn-cgi\//.test(u))
            : /verify|captcha|x-?captcha/i.test(u);
          if (!interesting) return;
          const pd = (req.postData() || '').slice(0, 500);
          const body = await res.text().catch(() => '');
          log(`NET ${res.status()} ${req.method()} ${u.slice(0, 130)}`);
          if (pd) log(`NET-REQ ${pd}`);
          if (body && !body.startsWith('<!DOCTYPE') && !body.startsWith('<html')) log(`NET-RES ${body.slice(0, 600)}`);
          else if (body) {
            // HTML result page — pull out any error/verdict text
            const m = body.match(/verification failed|try again|wrong|invalid|error[^<]{0,120}/i);
            if (m) log(`NET-RES-HTML ${m[0].slice(0, 300)}`);
          }
        } catch {}
      });
    }
    const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
    if (st.verifyRect) {
      const esc = await ensureClickable(page, st.verifyRect.x, st.verifyRect.y);
      if (esc !== 'ok' && !esc.startsWith('clear')) log(`verify click: ${esc}`);
      await page.mouse.click(st.verifyRect.x, st.verifyRect.y);
      log('Clicked Verify Selection');
    } else {
      const clicked = await page.evaluate(() => {
        const b = document.querySelector('[id^="cb_btn_"]');
        if (b) { b.click(); return true; }
        return false;
      }).catch(() => false);
      log(`Verify fallback click: ${clicked}`);
    }
    await navPromise;
    await sleep(2000);

    // Poll for result
    for (let i = 0; i < 10; i++) {
      const after = await getPageState(page);
      if (after.navError) { await sleep(1500); continue; }
      if (after.success) { log('Puzzle solved — claim successful!'); return true; }
      if (after.cooldown) { log('Cooldown after puzzle — claim likely succeeded'); return true; }
      if (after.verificationFailed) {
        // The platform's own rejection: "Verification failed, please try
        // again".  It leaves the ACCOUNT in a stuck state — every later solve
        // is rejected the same way until logout/login (user-observed).  Save
        // the evidence, back out before forceFail, and let claimFaucet's
        // session recovery replay the proven reset before the next round.
        await dismissSweetAlert(page);
        await page.screenshot({ path: `${SHOT_DIR}/verify-failed-${ts()}.png`, fullPage: true }).catch(() => {});
        log('Site said: verification failed — account state now needs a reset');
        return bailOutOfPuzzle(page, 'verification-failed', false);
      }
      if (after.captchaError) {
        await dismissSweetAlert(page);
        // A real attempt was rejected and the site is already serving a fresh
        // puzzle with a live countdown. Back out (so it cannot force-fail and
        // burn a second attempt) and report the failure to the ladder.
        return bailOutOfPuzzle(page, 'captcha-rejected', false);
      }
      if (after.verification && !after.success && i >= 3) {
        await dismissSweetAlert(page);
        // Silent reject: no error text in the DOM, but the verify went
        // nowhere.  Screenshot it — if the widget holds the message in its
        // closed shadow root, this is the only way to see it.
        await page.screenshot({ path: `${SHOT_DIR}/verify-stuck-${ts()}.png`, fullPage: true }).catch(() => {});
        log('Still verification after verify — reject');
        break;
      }
      if (after.puzzle && after.captchaAnswer === '') {
        log('Puzzle reset');
        break;
      }
      if (after.claimBtn && !after.verification && !after.puzzle && after.success) return true;
      await sleep(2000);
    }

    const mid = await getPageState(page);
    if (mid.success || mid.cooldown) return true;
    if (ci < maxTry - 1) {
      const cur = await getPageState(page);
      if (!cur.puzzle && !cur.verification) {
        if (cur.success || cur.cooldown) return true;
        break;
      }
      if (cur.puzzle) {
        // A fresh puzzle after an already-fired Verify is a rejection serving
        // the next round — re-entering would drag a widget that can never be
        // submitted (submitGuard), burning its countdown for nothing.
        if (submitGuard.used) return bailOutOfPuzzle(page, 'fresh-puzzle-after-verify', false);
        await page.evaluate(() => {
          const b = document.querySelector('[id^="rb_btn_"]');
          if (b) b.click();
        }).catch(() => {});
        await sleep(800);
        break; // re-enter handlePuzzle for fresh vision/py on new puzzle
      }
      if (cur.verification) {
        // Verify already fired this claim cycle: clicking cb here opens a
        // SECOND widget while the first round is still unresolved — the
        // re-entry then bails AFTER the new countdown started (the
        // "malfunctioning" double-widget sequence).  Bail cleanly instead;
        // claimFaucet resets the stuck session before the next round.
        if (submitGuard.used) return bailOutOfPuzzle(page, 'verify-unconfirmed', false);
        if (roundSpacingLeft() > 0) {
          log(`Round spacing: ${Math.round(roundSpacingLeft() / 1000)}s left — not re-opening widget`);
          return bailOutOfPuzzle(page, 'round-spacing', 'aborted');
        }
        const clicked = await page.evaluate(() => {
          const c = document.querySelector('[id^="cb_"]');
          if (c) { c.click(); return true; }
          return false;
        }).catch(() => false);
        if (clicked) { noteRoundStart(); await sleep(2500); }
        break;
      }
    }
  }

  await page.screenshot({ path: `${SHOT_DIR}/after-verify-${ts()}.png`, fullPage: true }).catch(() => {});
  const final = await getPageState(page);
  log(`After verify: success=${final.success} cooldown=${final.cooldown} puzzle=${final.puzzle} verif=${final.verification}`);
  if (final.success || final.cooldown) return true;
  if (attempt < 3) return handlePuzzle(page, attempt + 1);
  return false;
}

// ---------------------------------------------------------------------------
// Capture mode: gather real puzzle samples (screenshot + detector/vision
// output) WITHOUT ever dragging or clicking Verify — zero ban risk.
// ---------------------------------------------------------------------------

function clampClip(box, vp) {
  const clip = {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.min(box.w, vp.width),
    height: Math.min(box.h, vp.height),
  };
  if (clip.y + clip.height > vp.height) clip.height = Math.max(50, vp.height - clip.y);
  if (clip.x + clip.width > vp.width) clip.width = Math.max(50, vp.width - clip.x);
  return clip;
}

async function capturePuzzles(page, count = 3, maxMinutes = 12) {
  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
  const out = [];
  const rec = (o) => {
    out.push({ t: new Date().toISOString(), ...o });
    log(`CAPTURE ${JSON.stringify(o).slice(0, 500)}`);
  };
  const done = (status, extra = {}) => {
    const p = `${SHOT_DIR}/capture-${ts()}.json`;
    try { writeFileSync(p, JSON.stringify(out, null, 2)); } catch {}
    const samples = out.filter(e => e.ev === 'sample');
    log(`Capture trace written: ${p} (${out.length} events, ${samples.length} samples)`);
    return { status, samples, ...extra };
  };

  const deadline = Date.now() + maxMinutes * 60000;
  let st = await getPageState(page);
  let cbOpens = 0;
  let sampleIdx = 0;
  let lastClaimAt = 0;
  let waits = 0;
  // The widget force-fails (-1,-1, form submit) 50s after it appears: every
  // loop we must bail out (reload) before that or we burn a CAPTCHA attempt.
  // (FORCE_FAIL_MS / BAIL_MS are module-level.)
  let widgetShownAt = 0;

  while (sampleIdx < count && Date.now() < deadline) {
    st = await getPageState(page);
    const widgetOpen = !!(st.puzzle || st.hRect);
    if (widgetOpen && !widgetShownAt) widgetShownAt = Date.now();

    if (widgetShownAt && Date.now() - widgetShownAt > BAIL_MS) {
      rec({ ev: 'deadline-bail', openMs: Date.now() - widgetShownAt, forceFailAt: FORCE_FAIL_MS });
      widgetShownAt = 0;
      cbOpens = 0;
      await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      await ensureCleared(page);
      continue;
    }

    if (st.temporarilyBlocked) {
      rec({ ev: 'blocked', blockSec: st.blockSec });
      return done('blocked', { blockSec: st.blockSec ?? 3600 });
    }
    if (st.success && !st.verification && !st.puzzle) {
      rec({ ev: 'success-banner', text: (st.text || '').replace(/\n/g, ' | ').slice(0, 120) });
      await dismissSweetAlert(page);
      await sleep(2000);
      continue;
    }
    if (st.cooldown) {
      if (waits++ % 3 === 0) rec({ ev: 'cooldown', waitSec: st.waitSec });
      await sleep(Math.min(10000, Math.max(3000, (st.waitSec || 10) * 250)));
      continue;
    }

    // Capture the widget if it is open
    if (st.puzzle || st.hRect) {
      // Drift-verified capture: a calibration sample taken from a stale clip
      // (ad shifted the widget between measure and shot) is a poisoned label
      // — gate calibration must only ever see frames that held the canvas.
      const cap = await captureWidgetFrame(page, `capture-${ts()}-${sampleIdx}`);
      if (cap && cap.shot.length > 8000) {
        const shot = cap.shot;
        const shotPath = cap.path;
        const clip = cap.clip;
        const clipW = Math.round(clip.width);
        const clipH = Math.round(clip.height);
        const hole = findHolePy(shotPath, canvasRectFor(clip, await getCanvasTransform(page).catch(() => null)));
          let vision = null;
          for (let v = 0; v < 2 && !vision; v++) {
            try { vision = await analyzePuzzle(shot, clipW, clipH); }
            catch (e) { rec({ ev: 'vision-error', e: String(e.message).slice(0, 150) }); await sleep(1500); }
          }
          rec({
            ev: 'sample', i: sampleIdx, path: shotPath, bytes: shot.length, clip,
            answer: st.captchaAnswer || '', hole, vision,
          });
          sampleIdx++;
          if (sampleIdx >= count) break;

          // Reset the answer and close the widget so the next sample is fresh
          const reset = await page.evaluate(() => {
            const b = document.querySelector('[id^="rb_btn_"]');
            if (b) { b.click(); return true; }
            return false;
          });
          rec({ ev: 'reset', reset });
          cbOpens = 0;
          await sleep(2000);
          continue;
        }
      rec({ ev: 'blank-shot', bytes: cap ? cap.shot.length : 0 });
    }

    // Open the widget via the verification checkbox (opening is not an attempt)
    if (st.verification && st.cbRect && cbOpens < 3) {
      const spacingLeft = roundSpacingLeft();
      if (spacingLeft > 0) {
        // Rehearsal opens count server-side exactly like real ones — wait
        // out the 7-minute spacing instead of tripping the 1h block.
        rec({ ev: 'spacing-wait', ms: spacingLeft });
        await sleep(Math.min(spacingLeft + 5000, 30000));
        continue;
      }
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const cb = await getPageState(page);
      if (cb.cbRect) {
        const esc = await ensureClickable(page, cb.cbRect.x, cb.cbRect.y);
        if (esc.startsWith('neutralized')) log(`cb open: ${esc}`);
        await page.mouse.move(cb.cbRect.x, cb.cbRect.y, { steps: 4 });
        await sleep(200);
        noteRoundStart(); // the captcha_image REQUEST is the round's first event
        await page.mouse.click(cb.cbRect.x, cb.cbRect.y);
        cbOpens++;
        widgetShownAt = Date.now(); // fresh widget → fresh 50s force-fail countdown
        rec({ ev: 'cb-open', n: cbOpens });
        await sleep(3500);
        continue;
      }
    }

    // No puzzle offered: submit the claim form (free claims cost no attempt)
    if (st.claimBtn && !st.verification && !st.puzzle && Date.now() - lastClaimAt > 15000) {
      const submitted = await page.evaluate(() => {
        const form = document.querySelector('form[action*="faucet/verify"]');
        if (form) { form.submit(); return 'form'; }
        const btn = [...document.querySelectorAll('button')].find(b => /claim now/i.test(b.innerText || ''));
        if (btn) { btn.click(); return 'click'; }
        return false;
      });
      lastClaimAt = Date.now();
      rec({ ev: 'claim-submitted', submitted });
      await sleep(7000);
      const after = await getPageState(page);
      rec({
        ev: 'after-claim', verification: after.verification, puzzle: after.puzzle,
        captchaError: after.captchaError, cooldown: after.cooldown, waitSec: after.waitSec,
        blocked: after.temporarilyBlocked, blockSec: after.blockSec,
        text: (after.text || '').replace(/\n/g, ' | ').slice(0, 200),
      });
      if (after.temporarilyBlocked) return done('blocked', { blockSec: after.blockSec ?? 3600 });
      if (after.captchaError) { await dismissSweetAlert(page); rec({ ev: 'captcha-error-dismissed' }); }
      if (after.verification && after.cbRect === null && cbOpens >= 3) {
        rec({ ev: 'stuck-no-widget', text: (after.text || '').replace(/\n/g, ' | ').slice(0, 200) });
        break;
      }
      continue;
    }

    rec({ ev: 'idle', verification: st.verification, puzzle: st.puzzle, claimBtn: st.claimBtn, cb: !!st.cbRect });
    await sleep(3000);
  }

  st = await getPageState(page);
  rec({
    ev: 'final', success: st.success, cooldown: st.cooldown, blocked: st.temporarilyBlocked,
    blockSec: st.blockSec, answer: st.captchaAnswer || '',
    text: (st.text || '').replace(/\n/g, ' | ').slice(0, 200),
  });
  // Never leave a widget open: it would force-fail on its own after 50s.
  if (widgetShownAt && Date.now() - widgetShownAt < FORCE_FAIL_MS) {
    rec({ ev: 'final-bail', openMs: Date.now() - widgetShownAt });
    await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2000);
    await ensureCleared(page);
  }
  return done(st.temporarilyBlocked ? 'blocked' : 'captured');
}

// Bounded wait until the faucet page shows ANY actionable state.  goto()
// resolves at domcontentloaded and Cloudflare clearing proves only that the
// shell rendered — the claim widget/ads hydrate later, and deciding (or
// clicking) on a half-rendered page is exactly the "too fast, page not loaded"
// behaviour observed from the outside.  Returns the first ready state, or the
// final one on timeout.
async function waitForFaucetReady(page, timeout = 10000) {
  const end = Date.now() + timeout;
  let st = await getPageState(page);
  while (Date.now() < end) {
    if (st.navError || st.claimBtn || st.hasForm || st.verification || st.puzzle
      || st.v5 || st.success || st.cooldown || st.temporarilyBlocked) return st;
    await sleep(700);
    st = await getPageState(page);
  }
  return st;
}

// Stuck verification state: after a rejected/unconfirmed Verify the platform
// answers EVERY subsequent solve with "Verification failed, please try again"
// — even a correct manual drag from a fresh browser — until the account logs
// out and back in (user-observed reset).  Replay that proven workaround
// instead of failing every round that follows one bad Verify.
async function recoverSession(page, email) {
  log('Session recovery: logout -> login (reset stuck verification state)');
  const t0 = Date.now();
  const deadline = t0 + 360000;

  // Phase 1 — logout, VERIFIED on a real content page.  The logout nav gets
  // CF-challenged; once23's "logout ok" was read off a challenge page
  // (isLoggedIn=false there means nothing), the server session survived and
  // recover2 then found the profile still logged in — i.e. the stuck
  // verification never actually reset.  Require: challenge cleared + origin
  // URL + real body + negative isLoggedIn, else try the direct endpoints.
  const logoutPaths = ['/auth/logout', '/logout'];
  let loggedOut = false;
  for (let attempt = 0; attempt <= logoutPaths.length && !loggedOut; attempt++) {
    if (attempt === 0) {
      const clicked = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a')].find(el =>
          /logout/i.test((el.innerText || '').trim()) || /logout/i.test(el.getAttribute('href') || ''));
        if (a) { a.click(); return true; }
        return false;
      }).catch(() => false);
      if (!clicked) { log('logout: no logout link — using direct endpoint'); continue; }
    } else {
      log(`logout: direct endpoint ${logoutPaths[attempt - 1]}`);
      try { await page.goto(`${BASE_URL}${logoutPaths[attempt - 1]}`, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
    }
    await sleep(2500);
    const cleared = await ensureCleared(page);
    const cs = await getChallengeState(page).catch(() => ({ onChallenge: true }));
    const bodyLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
    const realPage = !cs.onChallenge && page.url().startsWith(BASE_URL) && bodyLen > 60;
    loggedOut = realPage && !(await isLoggedIn(page));
    log(`logout attempt ${attempt}: cleared=${cleared} realPage=${realPage} loggedOut=${loggedOut} url=${page.url().slice(0, 70)}`);
    if (!cleared) { log('logout: challenge stuck — aborting recovery'); return false; }
    if (Date.now() > deadline) { log('logout: recovery deadline hit'); return false; }
  }
  log(`logout ${loggedOut ? 'ok' : 'DID NOT TAKE'} [${Math.round((Date.now() - t0) / 1000)}s]`);
  if (!loggedOut) {
    log('Session recovery: cannot reset stuck verification without a real logout');
    return false;
  }

  const ok = await login(page, email);
  if (ok) {
    await gotoRetry(page, FAUCET_URL);
    await sleep(3000);
    await ensureCleared(page);
  } else {
    // Login already aborted on an uncleared challenge; navigating to the
    // faucet now would just spawn another challenge instance for nothing.
    log('Session recovery: LOGIN FAILED — skipping faucet nav');
  }
  log(`Session recovery ${ok ? 'done' : 'LOGIN FAILED'} in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (ok) noteRecoveryDone();  // pending captcha may be engaged once, immediately
  return ok;
}

async function claimFaucet(page, email, retried = false) {
  submitGuard.used = false; // fresh claim cycle => allowed one Verify
  log('Checking faucet status...');
  await ensureCleared(page);
  let st = await waitForFaucetReady(page, 10000);
  log(`state: success=${st.success} verif=${st.verification} puzzle=${st.puzzle} cooldown=${st.cooldown} wait=${st.waitSec}s claimBtn=${st.claimBtn} blocked=${st.temporarilyBlocked} blockSec=${st.blockSec}`);

  if (st.temporarilyBlocked) {
    await page.screenshot({ path: `${SHOT_DIR}/blocked-${Date.now()}.png`, fullPage: true }).catch(() => {});
    log(`TEMPORARILY BLOCKED — remaining ${st.blockSec ?? '?'}s. Will wait until unlock.`);
    if (st.success) {
      // Credit + block on the same read (observed 13:28: a manual widget solve
      // auto-claims, then the block surfaces).  Record it here — the success
      // branch below never runs once we return blocked.  No dismiss: the
      // block banner's text is what waitOutBlock polls.
      const n = bumpClaim(email);
      log(`Success already shown. Claims=${n} (recorded during block)`);
    }
    return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
  }

  if (st.success) {
    await dismissSweetAlert(page);
    const n = bumpClaim(email);
    log(`Success already shown. Claims=${n}`);
    return 'success';
  }

  if (st.captchaError) {
    await dismissSweetAlert(page);
    st = await getPageState(page);
    if (st.temporarilyBlocked) {
      return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
    }
  }

  if (st.puzzle || st.verification || st.v5) {
    // A widget already on screen means its countdown is already running.
    if (st.puzzle) markWidgetShown();
    log('Verification/puzzle present — solving...');
    const ok = await handlePuzzle(page);
    if (ok === 'aborted') return 'aborted'; // bailed pre-submit: no attempt burned
    st = await getPageState(page);
    if (st.temporarilyBlocked) {
      // ok===false => a Verify WAS submitted and rejected just before the block
      // surfaced.  Carry the reject so the loop counts the fail and runs the
      // logout/login reset — swallowing it (old unconditional setCF(0)) let the
      // bot keep auto-attempting past the manual-pause ladder.
      if (ok !== false && (ok || st.success || st.cooldown)) {
        // Credit + block on the same read (observed 14:32: the platform
        // accepted the solve and slammed the 1h block together).  The success
        // branch below never runs once we return blocked, so record the
        // credit here — but never on ok===false (a stale banner must not
        // mask a rejected Verify).  No dismiss while the block modal is up:
        // waitOutBlock polls its text and a closed modal could fake a clear.
        const n = bumpClaim(email);
        log(`Claim via puzzle. Claims=${n} (recorded during block)`);
      }
      return { status: 'blocked', blockSec: st.blockSec ?? 3600, reject: ok === false };
    }
    if (ok || st.success || st.cooldown) {
      await dismissSweetAlert(page);
      const n = bumpClaim(email);
      log(`Claim via puzzle. Claims=${n}`);
      return 'success';
    }
    log('Puzzle solve did not confirm success');
    await recoverSession(page, email); // replay the logout/login reset BEFORE the next round
    return 'puzzle-failed';
  }

  if (st.cooldown) {
    log(`On cooldown: ${st.waitSec}s`);
    return 'cooldown';
  }

  if (st.hasForm && st.claimBtn) {
    if (await hasTurnstile(page)) {
      const token = await page.evaluate(() =>
        (document.querySelector('input[name="cf-turnstile-response"]')?.value || '')
      ).catch(() => '');
      if (token.length < 10) await solveTurnstile(page);
    }
    log('Submitting claim form...');
    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form[action*="faucet/verify"]');
      if (form) { form.submit(); return true; }
      const btn = [...document.querySelectorAll('button')].find(b => /claim now/i.test(b.innerText || ''));
      if (btn) { btn.click(); return 'clicked'; }
      return false;
    });
    log(`Submitted: ${submitted}`);
    // Blind 8s sleep used to read the page mid-navigation when the server was
    // slow — wait for a real state marker instead (min 4s for the redirect).
    await sleep(4000);

    st = await waitForFaucetReady(page, 9000);
    log(`after submit: success=${st.success} verif=${st.verification} puzzle=${st.puzzle} cooldown=${st.cooldown} wait=${st.waitSec} captchaErr=${st.captchaError}`);
    await page.screenshot({ path: `${SHOT_DIR}/after-submit-${Date.now()}.png`, fullPage: true }).catch(() => {});

    if (st.temporarilyBlocked) {
      if (st.success) {
        // Submit credited AND block surfaced on the same read — record the
        // credit before returning blocked (the success branch below is
        // otherwise unreachable).  Banner left up on purpose: waitOutBlock
        // polls the block text and a dismiss could fake an early clear.
        const n = bumpClaim(email);
        log(`Claim successful! Claims=${n} (recorded during block)`);
      }
      return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
    }
    if (st.captchaError) {
      await dismissSweetAlert(page);
      st = await getPageState(page);
      if (st.temporarilyBlocked) {
        return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
      }
    }

    if (st.success) {
      await dismissSweetAlert(page);
      const n = bumpClaim(email);
      log(`Claim successful! Claims=${n}`);
      return 'success';
    }
    if (st.puzzle || st.verification || st.v5) {
      const ok = await handlePuzzle(page);
      if (ok === 'aborted') return 'aborted'; // bailed pre-submit: no attempt burned
      st = await getPageState(page);
      if (st.temporarilyBlocked) {
        if (ok !== false && (ok || st.success || st.cooldown)) {
          // Same credit+block co-occurrence as the standalone puzzle path —
          // record the claim, keep the reject flag semantics intact.
          const n = bumpClaim(email);
          log(`Claim via puzzle after submit. Claims=${n} (recorded during block)`);
        }
        return { status: 'blocked', blockSec: st.blockSec ?? 3600, reject: ok === false };
      }
      if (ok || st.success || st.cooldown) {
        await dismissSweetAlert(page);
        const n = bumpClaim(email);
        log(`Claim via puzzle after submit. Claims=${n}`);
        return 'success';
      }
      await recoverSession(page, email); // replay the logout/login reset BEFORE the next round
      return 'puzzle-failed';
    }
    if (st.cooldown) {
      const n = bumpClaim(email);
      log(`Cooldown after submit (treated as success). Claims=${n}`);
      return 'success';
    }
    log(`Unexpected after submit: ${st.text.replace(/\n/g, ' | ').slice(0, 150)}`);
    return 'unknown';
  }

  log('No claim available');
  // Distinguish "genuinely nothing to claim" from "session died / page never
  // hydrated": a logged-out page otherwise sits at 'none' forever.  One
  // bounded re-login retry, then give up honestly.
  if (!retried && !(await isLoggedIn(page))) {
    log('No claim UI and not logged in — re-login and retry once');
    if (await login(page, email)) {
      await gotoRetry(page, FAUCET_URL);
      await sleep(3000);
      await ensureCleared(page);
      return claimFaucet(page, email, true);
    }
  }
  return 'none';
}

async function waitForCooldown(page, maxSec = 120) {
  for (let i = 0; i < maxSec / 5; i++) {
    const st = await getPageState(page);
    if (st.temporarilyBlocked) return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
    if (!st.cooldown && (st.claimBtn || st.verification || st.puzzle)) return true;
    if (st.success) return 'success';
    log(`Cooldown wait ${st.waitSec ?? '?'}s...`);
    await sleep(5000);
  }
  return false;
}

// Sleep until temporary ban unlocks (poll every 30s; never start a 3rd captcha attempt).
async function waitOutBlock(page, blockSec) {
  const total = Math.max(30, Math.min(blockSec || 3600, 3700));
  log(`Waiting out temporary block for ~${total}s (${Math.round(total / 60)} min)...`);
  const end = Date.now() + total * 1000;
  while (Date.now() < end) {
    const remain = Math.ceil((end - Date.now()) / 1000);
    if (remain % 60 < 30 && remain > 0) log(`Block remaining ~${remain}s`);
    // Light poll so we can exit early if UI changes
    if (remain > 20) {
      await sleep(30000);
    } else {
      await sleep(10000);
    }
    try {
      const st = await getPageState(page);
      if (!st.temporarilyBlocked && (st.claimBtn || st.puzzle || st.verification || st.success || st.cooldown)) {
        log('Block appears cleared early — resuming');
        return true;
      }
    } catch {}
  }
  log('Block wait finished');
  return true;
}

// After 2 failed captcha solves, pause until the user solves manually.
// Manual success (or clear claim-ready state) resets the failure counter.
async function waitManualSolve(page) {
  log('CAPTCHA FAIL PAUSE: 2 failed solves — waiting for you to solve manually (3rd fail would ban).');
  await page.screenshot({ path: `${SHOT_DIR}/manual-pause-${Date.now()}.png`, fullPage: true }).catch(() => {});
  let clearStreak = 0;
  for (let i = 0; ; i++) {
    try {
      const st = await getPageState(page);
      if (st.success || st.cooldown) {
        log('Manual solve detected (success/cooldown) — failure counter reset');
        return 'reset';
      }
      // Puzzle cleared and claim button back without block → ready again.
      // st.v5 MUST be checked: the v5 card hides the gate (verif=false), so a
      // card the user just opened read as "claim ready" and the bot hijacked
      // their manual attempt (observed 10:28).  Two consecutive clean polls
      // ~3s apart guard the gate-hidden/card-drawing window too.
      const clear = !st.puzzle && !st.verification && !st.v5
        && !st.temporarilyBlocked && st.claimBtn;
      if (clear) {
        if (++clearStreak >= 2) {
          log('Manual solve detected (claim ready) — failure counter reset');
          return 'reset';
        }
      } else {
        clearStreak = 0;
      }
      if (st.temporarilyBlocked) {
        return { status: 'blocked', blockSec: st.blockSec ?? 3600 };
      }
    } catch {}
    if (i % 4 === 0) log(`Still paused for manual solve... (${i * 15}s)`);
    await sleep(15000);
  }
}

async function runOnce(email) {
  const ctx = await launchBrowser();
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
    await sleep(3000);
    await ensureCleared(page);
    if (!(await isLoggedIn(page))) {
      if (!(await login(page, email))) throw new Error('login failed');
    } else {
      log('Already logged in');
    }

    if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
    await sleep(4000);
    await ensureCleared(page);

    const result = await claimFaucet(page, email);
    log(`Result: ${typeof result === 'object' && result !== null ? JSON.stringify(result) : result}`);
    return result;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function runLoop(email) {
  log('=== OnlyFaucet Bot Started ===');
  let ctx = null;
  let page = null;
  let fails = 0;
  // Separate from generic fails: only failed captcha/puzzle solves count toward the 2-attempt pause.
  // 3 failed CAPTCHA attempts = site ban; never auto-attempt a 3rd.
  // Persisted: the platform's penalty is server-side and outlives restarts.
  let captchaFails = getCaptchaFails(email);
  const MAX_CAPTCHA_FAILS = 2;
  const setCF = (n) => { captchaFails = n; setCaptchaFails(email, n); };
  if (captchaFails) log(`Resuming with ${captchaFails}/${MAX_CAPTCHA_FAILS} persisted captcha fails`);
  // Safe bail-outs (deadline / low-confidence read) are not failures: no
  // attempt was submitted, so they never touch the failure ladder.
  let aborts = 0;

  while (true) {
    try {
      if (!ctx || !page || page.isClosed()) {
        if (ctx) await ctx.close().catch(() => {});
        ctx = await launchBrowser();
        page = ctx.pages()[0] || (await ctx.newPage());
        if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
        await sleep(3000);
        await ensureCleared(page);
        if (!(await isLoggedIn(page)) && !(await login(page, email))) throw new Error('login failed');
        if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
        await sleep(4000);
        await ensureCleared(page);
        noteRecoveryDone();  // connection-error relaunch + relogin: permit one immediate engage
        fails = 0;
      }

      // Ensure on faucet page
      if (!page.url().includes('/faucet/')) {
        if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
        await sleep(3000);
        await ensureCleared(page);
      }

      // Pause gate: after 2 captcha fails, do nothing until user solves (resets counter).
      if (captchaFails >= MAX_CAPTCHA_FAILS) {
        const pause = await waitManualSolve(page);
        if (pause && pause.status === 'blocked') {
          await waitOutBlock(page, pause.blockSec);
          await gotoRetry(page, FAUCET_URL);
          await sleep(3000);
          await ensureCleared(page);
          // Never reset the ladder here: a block does not erase the rejects
          // that put us in the pause (old setCF(0) un-paused us for free).
          fails = 0;
          continue;
        }
        setCF(0);
        fails = 0;
        log('Resuming after manual solve');
        continue;
      }

      const result = await claimFaucet(page, email);

      if (result && result.status === 'blocked') {
        await waitOutBlock(page, result.blockSec);
        await gotoRetry(page, FAUCET_URL);
        await sleep(4000);
        await ensureCleared(page);
        if (result.reject) {
          // Rejected Verify rode in with the block: count it (ladder) and run
          // the logout/login reset — this path used to fall through to
          // setCF(0), silently erasing the fail and disabling the pause gate.
          setCF(captchaFails + 1);
          log(`Captcha solve failed around block (${captchaFails}/${MAX_CAPTCHA_FAILS}) — recovering session`);
          await recoverSession(page, email);
          if (captchaFails >= MAX_CAPTCHA_FAILS) {
            log('Reached 2 captcha fails — entering manual-solve pause (no auto 3rd attempt)');
            fails = 0;
            continue; // pause gate runs next iteration
          }
        }
        fails = 0;
        continue;
      }

      if (result === 'aborted') {
        aborts++;
        log(`Puzzle abandoned safely (${aborts}) — nothing submitted, retrying without penalty`);
        // Retry as soon as it is legal.  A BAIL-fresh round still owes the
        // 7min event floor (its reload cost an event; >=3 events/~7min =>
        // 1h block, issued lazily on the next load) — roundSpacingLeft() IS
        // that floor, so wait exactly that instead of the old fixed
        // 420/600/900s ladder: the ladder overshot (abort with 171s of
        // spacing left still waited 420s) and froze the loop for minutes
        // with a visible widget and zero events being spent.  Free aborts
        // (nothing opened) and clean rounds retry after a short pause —
        // the gate-open guards apply the floor only while bailFresh().
        const wait = bailFresh() && roundSpacingLeft() > 0
          ? roundSpacingLeft() + 5000
          : 20000;
        log(`Open-rate protection: waiting ${Math.round(wait / 1000)}s before re-claim`);
        await sleep(wait);
        continue;
      }

      if (result === 'success') {
        fails = 0;
        setCF(0);
        aborts = 0;
        // Wait cooldown then claim again on same page (no refresh unless needed)
        const ready = await waitForCooldown(page, 60);
        if (ready && ready.status === 'blocked') {
          await waitOutBlock(page, ready.blockSec);
          await gotoRetry(page, FAUCET_URL);
          await sleep(4000);
          await ensureCleared(page);
          setCF(0);
          fails = 0;
          continue;
        }
        if (ready === 'success') {
          await dismissSweetAlert(page);
          bumpClaim(email);
        }
        await sleep(2000);
      } else if (result === 'cooldown') {
        setCF(0);
        await waitForCooldown(page, 60);
        await sleep(2000);
      } else if (result === 'puzzle-failed') {
        setCF(captchaFails + 1);
        fails = 0; // captcha fail is its own ladder — don't stack with generic reload fails
        log(`Captcha solve failed (${captchaFails}/${MAX_CAPTCHA_FAILS}) — will pause before next attempt if limit hit`);
        if (captchaFails >= MAX_CAPTCHA_FAILS) {
          log('Reached 2 captcha fails — entering manual-solve pause (no auto 3rd attempt)');
          continue; // pause gate runs next iteration
        }
        await sleep(10000);
      } else {
        fails++;
        log(`Non-success (${result}), fails=${fails}`);
        if (fails >= 3) {
          log('Reloading faucet page...');
          await gotoRetry(page, FAUCET_URL);
          await sleep(4000);
          await ensureCleared(page);
          fails = 0;
        } else {
          await sleep(10000);
        }
      }
    } catch (e) {
      log(`ERROR: ${e.message.slice(0, 100)}`);
      fails++;
      if (ctx) { await ctx.close().catch(() => {}); ctx = null; page = null; }
      await sleep(15000);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI (guarded: this module is also imported by capture/diagnostic tools)
// ---------------------------------------------------------------------------

export {
  log, sleep, launchBrowser, gotoRetry, waitForCloudflare, ensureCleared, hasTurnstile,
  solveTurnstile, isLoggedIn, login, dismissSweetAlert, getPageState, getPuzzleBox,
  handlePuzzle, capturePuzzles, findHolePy, findPiecePy, analyzePuzzle, claimFaucet,
  recoverSession,
  waitForCooldown, waitOutBlock, waitManualSolve, loadAccounts,
  getCanvasTransform, canvasRectFor, freshGeom, freshBgPath, clampClip, consensusGate,
  ensureClickable, captureWidgetFrame, noteRoundStart, roundSpacingLeft,
  canvasToPage, dragCanvas,
  BASE_URL, FAUCET_URL, SHOT_DIR,
};

// Dry-run of the v5 flow: full production path up to (but excluding) Verify.
// Spends at most ONE round event (the gate click; no bail reload on success),
// writes noteRoundStart via markWidgetShown, and never submits an attempt.
async function runDryV5(email) {
  if (roundSpacingLeft() > 0) {
    log(`Round spacing active (${Math.round(roundSpacingLeft() / 1000)}s left) — dry-run refused`);
    return 'spacing';
  }
  dryRunMode = true;
  const ctx = await launchBrowser();
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
    await sleep(3000);
    await ensureCleared(page);
    if (!(await isLoggedIn(page))) {
      if (!(await login(page, email))) throw new Error('login failed');
    } else {
      log('Already logged in');
    }
    if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
    await sleep(4000);
    await ensureCleared(page);
    const st = await waitForFaucetReady(page);
    if (st.success) { log('Dry-run: already successful, nothing to open'); return 'success'; }
    if (st.cooldown) { log(`Dry-run: on cooldown (${st.waitSec}s), nothing to open`); return 'cooldown'; }
    const r = await handlePuzzleV5(page, 0);
    log(`Dry-run v5 result: ${r}`);
    return r;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function runCapture(count, maxMinutes = 12) {
  const accounts = loadAccounts();
  const email = process.env.LOGIN_EMAIL || process.env.EMAIL || accounts[0]?.email;
  const ctx = await launchBrowser();
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
    await sleep(3000);
    await ensureCleared(page);
    if (!(await isLoggedIn(page))) {
      const ok = await login(page, email);
      if (!ok) throw new Error('login failed');
    } else {
      log('Already logged in');
    }
    if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
    await sleep(4000);
    await ensureCleared(page);
    const res = await capturePuzzles(page, count, maxMinutes);
    log(`Capture done: status=${res.status} samples=${(res.samples || []).length}`);
    return res;
  } finally {
    await ctx.close().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === 'add' && args[1]) {
    addAccount(args[1]);
  } else if (args[0] === 'list') {
    loadAccounts().forEach(a => console.log(`${a.email} - Claims: ${a.claims} - Last: ${a.lastClaim || 'never'}`));
  } else if (args[0] === 'capture') {
    // Screenshot + detect only — never drags, never submits an attempt.
    const n = Number(args[1] || 3);
    acquireLock();
    runCapture(n)
      .then(r => { process.exit(r.status === 'blocked' ? 2 : 0); })
      .catch(e => { console.error(e); process.exit(1); });
  } else if (args[0] === 'once') {
    const accounts = loadAccounts();
    if (!accounts.length) { console.error('No accounts'); process.exit(1); }
    acquireLock(); // one browser profile at a time — a concurrent loop/once pair corrupts it
    runOnce(accounts[0].email).then(r => { console.log(`done: ${r}`); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  } else if (args[0] === 'dryv5') {
    // Full v5 path minus Verify: gate -> capture -> solve -> taps -> stop.
    const accounts = loadAccounts();
    if (!accounts.length) { console.error('No accounts'); process.exit(1); }
    acquireLock();
    runDryV5(accounts[0].email).then(r => { console.log(`dry-run: ${r}`); process.exit(r === 'dryrun' ? 0 : 1); })
      .catch(e => { console.error(e); process.exit(1); });
  } else if (args[0] === 'recover') {
    // One-shot logout -> login reset (no round events): for a reject whose
    // recovery was skipped, e.g. when the block return swallowed it.
    const accounts = loadAccounts();
    if (!accounts.length) { console.error('No accounts'); process.exit(1); }
    acquireLock();
    (async () => {
      const ctx = await launchBrowser();
      const page = ctx.pages()[0] || (await ctx.newPage());
      let ok = false;
      try {
        if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
        await sleep(2000);
        await ensureCleared(page);
        if (!(await isLoggedIn(page))) { console.log('recover: not logged in — nothing to reset'); await ctx.close().catch(() => {}); process.exit(0); }
        ok = await recoverSession(page, accounts[0].email);
      } finally { await ctx.close().catch(() => {}); }
      console.log(`recover: ${ok ? 'ok' : 'failed'}`);
      process.exit(ok ? 0 : 1);
    })().catch(e => { console.error(e); process.exit(1); });
  } else {
    acquireLock();
    const accounts = loadAccounts();
    if (!accounts.length) {
      log('No accounts found. Run: node bot.mjs add <email>');
      process.exit(0);
    }
    runLoop(accounts[0].email).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
  }
}
