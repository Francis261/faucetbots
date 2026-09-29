#!/usr/bin/env node
// terabot.mjs — TeraBox share bot
// Extracts video metadata and download links from a 1024tera.com / TeraBox
// share link, optionally downloads, and runs the REST API — one command:
//
//   node terabot.mjs                start the REST API server on
//                                   127.0.0.1:8788 (auto-login if
//                                   .account.json exists but no cookies)
//   node terabot.mjs serve [...]    same, with options (--port 9000
//                                   --host 0.0.0.0 --out DIR --cookies FILE
//                                   --concurrency N)
//   node terabot.mjs login          log in (headless; HEADFUL=1 or
//                                   --headful for a visible window) and
//                                   save cookies.json
//   node terabot.mjs help           this help
//
// One-shot extraction (any of the flags below = CLI mode):
//
//   node terabot.mjs [share-url] [--download] [--download-original]
//                    [--json] [--out DIR] [--cookies FILE] [--browser]
//
//   --download          fetch every HLS segment, stitch the full 480p
//                       transcode and remux to .mp4 with ffmpeg (fast,
//                       works anonymously)
//   --download-original download the original file via the dlink — needs
//                       --cookies (logged-in session); the free-tier CDN
//                       trickles ~10-50KB/s per connection, so the file is
//                       pulled as parallel byte ranges (~10 min / 30MB)
//   --json              print the full metadata JSON to stdout
//   --out DIR           output directory (default: <script dir>/output)
//   --cookies FILE      Playwright storageState with a logged-in TeraBox
//                       session (create with `node terabot.mjs login`);
//                       anonymous sessions get errno 2 / "need verify_v2"
//                       from /share/download
//   --browser           skip the fast path and use the Playwright flow
//                       (extraction normally runs browser-free in ~3s:
//                       curl --http2 fetches the share HTML for its
//                       jsToken/pcftoken, every API call is plain fetch)
//
// How the preview download works (anonymous):
//   /share/streaming serves HLS windows of ~3 segments (30s) at a RANDOM
//   offset of the 480p transcode on every request.  The bot refetches the
//   playlist, unions the byte ranges until [0, ts_size) is fully covered,
//   then downloads each unique segment from the signed CDN URLs (cookie-free)
//   and stitches them back into the complete transport stream.
//
// How the original download works (logged-in):
//   The Download button calls POST /share/download with the frontend's
//   scene=purchased_list shape (Wt wrapper) and receives a signed
//   d.1024tera.com dlink that expires in ~10 min.  The CDN requires the
//   session cookies and throttles free accounts (~10-50KB/s per
//   connection), so the bot fetches parallel 2MB ranges through Playwright's
//   cookie-sharing request context, refreshing the dlink near expiry, then
//   reassembles and verifies size + md5 against the share metadata.

// playwright is loaded lazily: the fast path never boots Chromium, and the
// import itself costs ~3-4 s of startup.
let _chromium;
const getChromium = async () =>
  (_chromium ||= (await import('playwright')).chromium);
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_URL =
  'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const SALT = 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa'; // HMAC key from share bundle
const STREAM_TYPE = 'M3U8_FLV_264_480'; // non-Safari 480p rendition

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = {
    url: DEFAULT_URL, download: false, downloadOriginal: false, json: false,
    out: path.join(__dirname, 'output'), cookies: null, mode: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--download') opts.download = true;
    else if (a === '--download-original') opts.downloadOriginal = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--browser') opts.mode = 'browser';
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--cookies') opts.cookies = path.resolve(argv[++i]);
    else if (a === '--url') opts.url = argv[++i];
    else if (!a.startsWith('-') && a.includes('http')) opts.url = a;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

// ============================================================ fast path
// Browser-free extraction (~3 s instead of ~22 s).
//
// The share HTML embeds jsToken/pcftoken, but the server only issues USABLE
// tokens when the HTML request itself looks like a browser's (HTTP/2 +
// browser headers): a plain undici fetch() of the page yields tokens that
// make /share/list and /share/download answer "need verify" (errno
// 4000020/460020, and 400310 "need verify_v2" for the dlink).  curl --http2
// with a browser UA is enough to get accepted tokens — then every API call
// runs with plain fetch.  If curl is unavailable, the HTML document body is
// taken from a short-lived Playwright page (commit stage only, no app boot).
const ORIGIN = 'https://www.1024tera.com';

class Jar {
  constructor() { this.m = new Map(); }
  load(storageStatePath) {
    const st = JSON.parse(readFileSync(storageStatePath, 'utf8'));
    for (const c of st.cookies || []) {
      if (/(^|\.)1024tera\.com$/.test(String(c.domain).replace(/^\./, '')))
        this.m.set(c.name, c.value);
    }
  }
  setCookieLine(line) {
    const kv = String(line).split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) this.m.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  absorb(res) {
    const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of all) this.setCookieLine(c);
  }
  header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(name) { return this.m.get(name) || ''; }
}

const parseHtmlTokens = (html) => {
  const jt = (decodeURIComponent(
    (html.match(/eval\(decodeURIComponent\(`([^`]+)`\)\)/) || [])[1] || '',
  ).match(/fn\("([0-9A-F]+)"\)/) || [])[1] || '';
  const tdM = html.match(/var templateData = (\{.*?\});<\/script>/s) ||
    html.match(/var templateData = (\{.*?\});/s);
  let td = {};
  try { td = tdM ? JSON.parse(tdM[1]) : {}; } catch { /* malformed */ }
  return {
    jsToken: jt,
    pcftoken: (td && td.pcftoken) || '',
    bdstoken: (td && td.bdstoken) || '',
  };
};

let curlAvailable;
const haveCurl = () => {
  if (curlAvailable === undefined) {
    curlAvailable =
      spawnSync('curl', ['--version'], { encoding: 'utf8' }).status === 0;
  }
  return curlAvailable;
};

async function fetchShareHtml(url, jar, storageStatePath) {
  if (haveCurl()) {
    const hdrFile = path.join(tmpdir(), `terabot-${process.pid}.hdrs`);
    const r = spawnSync('curl', [
      '-sSL', '--http2', '--compressed', '--max-time', '25',
      '-A', UA, '-H', `cookie: ${jar.header()}`, '-H', `referer: ${url}`,
      '-D', hdrFile, url,
    ], { encoding: 'utf8', maxBuffer: 1 << 24 });
    let head = '';
    try { head = readFileSync(hdrFile, 'utf8'); } catch { /* no file */ }
    for (const m of head.matchAll(/^set-cookie:\s*(.+)$/gim)) jar.setCookieLine(m[1]);
    if (r.status === 0 && r.stdout && r.stdout.includes('templateData'))
      return r.stdout;
  }
  // fallback: document body from a browser request (commit stage — the app
  // does not need to boot; jsToken/pcftoken are embedded in the HTML)
  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: UA, viewport: { width: 1280, height: 800 },
      ...(storageStatePath && existsSync(storageStatePath)
        ? { storageState: storageStatePath } : {}),
    });
    const page = await ctx.newPage();
    const bodyP = page.waitForResponse(
      (res) => res.url().includes('/sharing/link?') &&
        res.request().resourceType() === 'document');
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    const body = await (await bodyP).text();
    for (const c of await ctx.cookies()) {
      if (c.domain.includes('1024tera')) jar.m.set(c.name, c.value);
    }
    return body;
  } finally {
    await browser.close().catch(() => {});
  }
}

// One full browser-free extraction.  Returns the same shape the browser
// flow builds ({cap, videoFiles, downloads}) so the download/metadata tail
// is shared verbatim.  Throws on any hard failure — the caller then falls
// back to the proven Playwright flow.
async function fastExtract(opts, { log, mark }) {
  const jar = new Jar();
  if (opts.cookies && existsSync(opts.cookies)) jar.load(opts.cookies);

  log(`[terabot] opening ${opts.url} (fast path — no browser boot)`);
  const html = await fetchShareHtml(opts.url, jar, opts.cookies);
  const tok = parseHtmlTokens(html);
  if (!tok.jsToken || !tok.pcftoken)
    throw new Error('share page did not embed jsToken/pcftoken');
  mark('html');

  // dp-logid exactly as the frontend dplogid-2.0.3 lib generates it:
  // sessionId(6 random digits) + "00"+8 digits + 4-digit counter
  const dpSession = String(Math.floor((9 * Math.random() + 1) * 1e5));
  const dpUser = '00' + Math.floor((9 * Math.random() + 1) * 1e7);
  let dpCount = 0;
  const nextDpLogid = () => {
    dpCount = dpCount < 9999 ? dpCount + 1 : 0;
    return dpSession + dpUser + String(dpCount).padStart(4, '0');
  };
  const common = (extra = {}) => new URLSearchParams({
    clientfrom: 'h5', psign: '0', pcftoken: tok.pcftoken,
    clienttype: '0', channel: 'dubox', app_id: '250528', web: '1',
    jsToken: tok.jsToken, 'dp-logid': nextDpLogid(), ...extra,
  });
  const HEAD = (extra) => ({
    'user-agent': UA, cookie: jar.header(), referer: opts.url,
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/x-www-form-urlencoded',
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...extra,
  });
  const parse = async (r) => {
    jar.absorb(r);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return null; }
  };
  const jget = async (p) => {
    const j = await parse(await fetch(`${ORIGIN}${p}`, { headers: HEAD() }));
    if (!j) throw new Error(`bad JSON from ${p.split('?')[0]}`);
    return j;
  };
  const surl = new URL(opts.url).searchParams.get('surl');
  if (!surl) throw new Error('url has no surl parameter');

  // ---- share info (sign / shareid / uk) --------------------------------
  let shareRaw = null;
  for (const shorturl of ['1' + surl, surl]) {
    const j = await jget(`/api/shorturlinfo?${common({
      shorturl, root: '1', scene: '',
    })}`);
    if (j.errno === 0) { shareRaw = j; break; }
  }
  if (!shareRaw) throw new Error('shorturlinfo failed for both surl shapes');
  mark('info');

  // ---- file list (+ pagination for large shares) ------------------------
  const listPage = (pageN) => jget(`/share/list?${common({
    page: String(pageN), num: '20', shorturl: surl, root: '1',
    by: 'time', order: 'desc', scene: '',
  })}`);
  const lj = await listPage(1);
  if (!lj || (lj.errno !== 0 && lj.errno !== undefined) || !Array.isArray(lj.list))
    throw new Error(`list failed (${lj ? lj.errno ?? lj.code : 'no JSON'}: ` +
      `${(lj && (lj.errmsg || lj.show_msg)) || ''})`);
  const files = [...lj.list];
  let nextPage = 2;
  while (files.length < Number(shareRaw.fcount || 0) && nextPage <= 10) {
    const more = await listPage(nextPage++);
    if (!more || more.errno !== 0 || !Array.isArray(more.list) || !more.list.length) break;
    for (const f of more.list) if (!files.some((x) => x.fs_id === f.fs_id)) files.push(f);
  }
  if (!files.length) throw new Error('list returned no files');
  mark('list');
  log(`[terabot] share ${shareRaw.shareid} (uk ${shareRaw.uk}) — ` +
    `${files.length} file(s)`);

  const cap = {
    shareRaw, files, listUrls: [], mediaMeta: {},
    jsToken: tok.jsToken, dpLogid: null,
  };
  const si = {
    shareid: shareRaw.shareid, uk: shareRaw.uk,
    sign: shareRaw.sign, timestamp: String(shareRaw.timestamp ?? ''),
  };

  // ---- parallel: mediameta, HLS harvest, share transfer ------------------
  const candidates = files.filter((f) => !(f.isdir === '1' || f.isdir === 1));
  const metaOf = async (f) => {
    if (String(f.category) !== '1') return null;
    const j = await jget(`/share/mediameta?${common({
      uk: String(si.uk), shareid: String(si.shareid), fid: String(f.fs_id),
      timestamp: String(si.timestamp),
    })}`);
    if (j && j.errno === 0 && j.duration) { cap.mediaMeta[f.fs_id] = j; return j; }
    return null;
  };
  const harvestHlsFast = async (fid, maxIter = 80) => {
    const browserid = jar.get('browserid') || '';
    const segs = new Map();
    const ivs = [];
    let tsSize = 0, covered = 0, err = null, fetches = 0, example = null;
    const merge = () => {
      ivs.sort((a, b) => a[0] - b[0]);
      const m = [];
      for (const iv of ivs) {
        if (!m.length || iv[0] > m[m.length - 1][1] + 1) m.push([...iv]);
        else m[m.length - 1][1] = Math.max(m[m.length - 1][1], iv[1]);
      }
      return m;
    };
    const one = async () => {
      const ts = Math.floor(Date.now() / 1000);
      const sign = createHmac('sha1', SALT)
        .update(`0dubox${browserid}${ts}`).digest('hex');
      const q = new URLSearchParams({
        uk: String(si.uk), shareid: String(si.shareid), type: STREAM_TYPE,
        fid: String(fid), sign, timestamp: String(ts),
        jsToken: tok.jsToken, esl: '1', isplayer: '1', ehps: '1',
        clienttype: '0', app_id: '250528', web: '1', channel: 'dubox',
      });
      fetches++;
      const pl = await (await fetch(`${ORIGIN}/share/streaming?${q}`, {
        headers: HEAD(),
      })).text();
      return { pl, url: `${ORIGIN}/share/streaming?${q}` };
    };
    const absorbWindow = ({ pl, url }) => {
      if (!pl.startsWith('#EXTM3U')) { err = pl.slice(0, 200); return false; }
      if (!example) example = url;
      for (const line of pl.split('\n')) {
        if (!line.startsWith('http')) continue;
        const p = new URL(line);
        const range = p.searchParams.get('range');
        if (!range || segs.has(range)) continue;
        segs.set(range, { range, url: line });
        const b = Number(range.split('-')[1]);
        ivs.push([Number(range.split('-')[0]), b]);
        tsSize = Math.max(tsSize, Number(p.searchParams.get('ts_size') || 0));
      }
      covered = merge().reduce((s, [a, b]) => s + (b - a + 1), 0);
      return true;
    };
    // one window first (logged-in sessions get the full playlist), then
    // widen to batches of 4 — anonymous sessions serve random 30s windows
    let batch = await Promise.all([one()]);
    for (;;) {
      let okAll = true;
      for (const item of batch) if (!absorbWindow(item)) okAll = false;
      if (!okAll || (tsSize && covered >= tsSize) || fetches >= maxIter) break;
      const n = Math.min(4, maxIter - fetches);
      batch = await Promise.all(Array.from({ length: n }, one));
    }
    return {
      type: STREAM_TYPE, tsSize, covered, iterations: fetches,
      complete: tsSize > 0 && covered >= tsSize, error: err,
      segmentCount: segs.size, segments: [...segs.values()],
      playlistUrl: example || null,
    };
  };

  const transferP = opts.cookies
    ? (async () => {
      const r = await fetch(
        `${ORIGIN}/share/querysurltransfer?${common({ bdstoken: tok.bdstoken || '' })}`,
        {
          method: 'POST', headers: HEAD(),
          body: new URLSearchParams({
            sid: String(si.shareid), suk: String(si.uk),
          }).toString(),
        });
      const j = await parse(r);
      log(`[terabot] share transfer: errno ${j ? j.errno : '?'}${j && j.data ? ` (has_transferred ${j.data.has_transferred})` : ''}`);
      return j;
    })()
    : Promise.resolve(null);

  const metasP = Promise.all(candidates.map(metaOf));
  const harvestsP = Promise.all(
    candidates.filter((f) => String(f.category) === '1').map(async (f) => ({
      file: f, h: await harvestHlsFast(f.fs_id),
    })),
  );

  const [metas] = await Promise.all([metasP, transferP]);
  const videoFiles = candidates
    .map((f, i) => ({ file: f, meta: metas[i] }))
    .filter((v) => v.meta && v.meta.duration);
  mark('meta');

  // ---- original dlink (Wt shape; after the transfer handshake) ----------
  const downloads = { original: null, previewHLS: [] };
  const firstFile = videoFiles[0] ? videoFiles[0].file : files[0];
  const firstFid = firstFile.fs_id;
  log('[terabot] attempting original dlink…');
  try {
    const r = await fetch(`${ORIGIN}/share/download?${common({
      scene: 'purchased_list', shareid: String(si.shareid),
      sign: si.sign || '', timestamp: String(si.timestamp),
      bdstoken: tok.bdstoken || '',
    })}`, {
      method: 'POST',
      headers: HEAD({
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      }),
      body: new URLSearchParams({
        product: 'share', nozip: '0',
        fid_list: JSON.stringify([String(firstFid)]),
        uk: String(si.uk), primaryid: String(si.shareid),
      }).toString(),
    });
    const j = await parse(r);
    const dlink = (j && typeof j.dlink === 'string' && j.dlink) ||
      (j && Array.isArray(j.dlink) && j.dlink[0]) || null;
    downloads.original = {
      errno: (j && j.errno) ?? 0, available: !!dlink, dlink,
      file_info: j && j.file_info, raw: dlink ? undefined : j,
    };
  } catch (e) {
    downloads.original = {
      errno: -1, available: false, error: String(e).slice(0, 150),
    };
  }
  if (downloads.original.available) {
    log(`[terabot] original dlink OK: ` +
      `${downloads.original.dlink.slice(0, 160)}…`);
  } else {
    log(
      `[terabot] original dlink unavailable (errno ${downloads.original.errno})` +
      `${downloads.original.errno === 2 || downloads.original.errno === 400310
        ? ' — anonymous sessions need a logged-in cookie jar (--cookies)' : ''}`);
  }
  mark('dlink');
  // errno 14 = share not accepted: the browser flow's in-page handshake can
  // still register it — hand over to the fallback instead of returning junk
  if (downloads.original.errno === 14)
    throw new Error('dlink errno 14 (share not accepted) — trying browser flow');

  // ---- harvest results ---------------------------------------------------
  const harvests = await harvestsP;
  mark('harvest');
  if (harvests.length && harvests.every((x) => !x.h.segmentCount))
    throw new Error(`streaming harvest yielded no segments ` +
      `(${(harvests[0].h.error || '').slice(0, 120)}) — trying browser flow`);
  for (const { file, h } of harvests) {
    const meta = videoFiles.find((v) => v.file.fs_id === file.fs_id);
    if (!meta) continue;            // not a video after all — ignore its harvest
    if (h.error && !h.segmentCount) {
      log(`[terabot] harvest failed: ${h.error}`);
    } else {
      log(
        `[terabot] harvest: ${h.segmentCount} segments, ` +
        `${h.covered}/${h.tsSize} bytes in ${h.iterations} fetches` +
        `${h.complete ? ' (complete)' : ' (INCOMPLETE)'}`);
    }
    downloads.previewHLS.push({
      fid: file.fs_id, filename: file.server_filename,
      duration: meta.meta.duration, width: meta.meta.width,
      height: meta.meta.height,
      ...h,
      note: 'playlist serves random 30s windows; segments are the ' +
        'cookie-free signed CDN URLs covering the full 480p transcode',
    });
  }
  return { cap, videoFiles, downloads };
}

// ---------------------------------------------------------------- main
// Run one full extraction (optionally with downloads).
//
//   opts  — parseArgs() shape: {url, download, downloadOriginal, json, out,
//           cookies, quiet}
//   hooks — optional { log(msg), onProgress(info) }; defaults write to
//           stderr / no-op.  The REST API passes its own to feed job state.
//
// Returns { code, metadata, written, errors }; throws on fatal errors.
export async function runTerabot(opts, hooks = {}) {
  const log = hooks.log || console.error;
  const onProgress = hooks.onProgress || (() => {});
  const errors = [];
  mkdirSync(opts.out, { recursive: true });
  const t0 = Date.now();
  const timing = [];
  const mark = (stage) =>
    timing.push(`${stage}=${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- fast path first (browser-free); fall back to Playwright --------
  // --download-original still goes straight to the browser flow: the
  // chunked CDN download shares the page's request context.
  let cap = null;
  let videoFiles = [];
  let downloads = null;
  if (!opts.downloadOriginal && opts.mode !== 'browser') {
    try {
      const f = await fastExtract(opts, { log, mark });
      cap = f.cap; videoFiles = f.videoFiles; downloads = f.downloads;
      log('[terabot] fast path complete — no browser needed');
    } catch (e) {
      log(`[terabot] fast path failed: ${(e && e.message) || e} — using browser flow`);
      cap = null;
    }
  }

  let browser = null;
  let ctx = null;
  let tryOriginalDlink = null;
  try {
    if (!cap) {
    const chromium = await getChromium();
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      ...(opts.cookies && existsSync(opts.cookies)
        ? { storageState: opts.cookies }
        : {}),
    });
    const page = await ctx.newPage();

    // ---- capture hooks ------------------------------------------------
    cap = {
      shareRaw: null, files: [], listUrls: [], mediaMeta: {},
      jsToken: null, dpLogid: null,
    };
    page.on('request', (req) => {
      const u = req.url();
      if (!cap.jsToken) {
        const m = u.match(/jsToken=([A-F0-9]+)/);
        if (m) cap.jsToken = m[1];
      }
      if (!cap.dpLogid) {
        const m = u.match(/[?&]dp-logid=(\d+)/);
        if (m) cap.dpLogid = m[1];
      }
    });
    const parseJson = (res) => res.text().then((t) => JSON.parse(t));
    const saw = { transfer: false, checkLogin: false };
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('querysurltransfer')) saw.transfer = true;
      if (u.includes('/api/check/login')) saw.checkLogin = true;
      if (u.includes('/share/download?')) {
        log(`[net] POST /share/download :: ${u.slice(0, 600)}`);
        const pd = req.postData();
        if (pd) log(`[net]   body: ${pd.slice(0, 300)}`);
      }
    });
    page.on('response', (res) => {
      if (res.url().includes('/share/download?')) {
        res.text().then((t) => log(`[net]   resp: ${t.slice(0, 500)}`)).catch(() => {});
      }
    });
    page.on('response', (res) => {
      const u = res.url();
      try {
        if (u.includes('/api/shorturlinfo')) {
          parseJson(res).then((j) => { if (j.errno === 0) cap.shareRaw = j; }).catch(() => {});
        } else if (u.includes('/share/list?')) {
          cap.listUrls.push(u);
          parseJson(res).then((j) => {
            if (j.errno !== 0 || !Array.isArray(j.list)) return;
            for (const f of j.list) {
              if (!cap.files.some((x) => x.fs_id === f.fs_id)) cap.files.push(f);
            }
          }).catch(() => {});
        } else if (u.includes('/share/mediameta')) {
          const fid = new URL(u).searchParams.get('fid');
          parseJson(res).then((j) => { if (j.errno === 0 && fid) cap.mediaMeta[fid] = j; }).catch(() => {});
        }
      } catch { /* ignore malformed */ }
    });

    // ---- load ---------------------------------------------------------
    log(`[terabot] opening ${opts.url}`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    mark('goto');
    const got = await waitFor(() => cap.shareRaw && cap.files.length > 0, 20000);
    if (!got) {
      const title = await page.title().catch(() => '?');
      throw new Error(
        `share data did not load within 20s (title: ${title}) — ` +
        `link expired, deleted, or region-blocked?`,
      );
    }
    if (!cap.jsToken) cap.jsToken = await page.evaluate(() => window.jsToken || null);
    mark('data');

    // ---- paginate the file list (root pages beyond page 1) ------------
    let nextPage = 2;
    while (cap.files.length < cap.shareRaw.fcount &&
           cap.listUrls.length && nextPage <= 10) {
      const more = await page.evaluate(async ({ template, pageN, jsToken }) => {
        const u = new URL(template);
        u.searchParams.set('page', String(pageN));
        if (jsToken) u.searchParams.set('jsToken', jsToken);
        try {
          const r = await fetch(u);
          const j = await r.json();
          return j.errno === 0 && Array.isArray(j.list) ? j.list : [];
        } catch { return []; }
      }, { template: cap.listUrls[0], pageN: nextPage, jsToken: cap.jsToken });
      nextPage++;
      if (!more.length) break;
      for (const f of more) {
        if (!cap.files.some((x) => x.fs_id === f.fs_id)) cap.files.push(f);
      }
      await sleep(200);
    }

    // ---- in-page helpers ----------------------------------------------
    const pageEnv = await page.evaluate(() => ({
      browserid:
        (document.cookie.match(/(?:^|;\s*)browserid=([^;]+)/) || [])[1] || '',
      pcftoken:
        (document.cookie.match(/(?:^|;\s*)pcftoken=([^;]+)/) || [])[1] ||
        window.templateData?.pcftoken || '',
      bdstoken: window.templateData?.bdstoken ?? '',
      jsToken: window.jsToken || '',
    }));

    mark('env');
    // exact frontend shape for /share/download — the Wt wrapper used by the
    // Download button (scene=purchased_list); the os wrapper (scene="") gets
    // errno 14 even when logged in
    tryOriginalDlink = (fid) =>
      page.evaluate(async ({ si, fid, env, dpLogid }) => {
        const q = new URLSearchParams({
          clientfrom: 'h5', psign: '0', pcftoken: env.pcftoken,
          clienttype: '0', channel: 'dubox',
          scene: 'purchased_list',
          shareid: String(si.shareid), sign: si.sign,
          timestamp: String(si.timestamp), bdstoken: env.bdstoken,
          app_id: '250528', web: '1', jsToken: env.jsToken,
          'dp-logid': dpLogid || '',
        });
        try {
          const r = await fetch(`/share/download?${q}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: new URLSearchParams({
              product: 'share', nozip: '0',
              fid_list: JSON.stringify([String(fid)]),
              uk: String(si.uk),
              primaryid: String(si.shareid),
            }).toString(),
          });
          const j = await r.json();
          const dlink = (typeof j.dlink === 'string' && j.dlink) ||
            (Array.isArray(j.dlink) && j.dlink[0]) || null;
          return {
            errno: j.errno ?? 0, available: !!dlink, dlink,
            file_info: j.file_info, raw: dlink ? undefined : j,
          };
        } catch (e) {
          return { errno: -1, available: false, error: String(e).slice(0, 150) };
        }
      }, {
        si: { shareid: cap.shareRaw.shareid, uk: cap.shareRaw.uk, sign: cap.shareRaw.sign, timestamp: cap.shareRaw.timestamp },
        fid, env: pageEnv, dpLogid: cap.dpLogid,
      });

    // union-harvest: refetch random 30s windows until [0, ts_size) covered
    const harvestHls = (fid, maxIter = 80) =>
      page.evaluate(async ({ si, fid, jsToken, browserid, maxIter }) => {
        const hmacSha1 = async (msg, key) => {
          const enc = new TextEncoder();
          const k = await crypto.subtle.importKey(
            'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
          const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
          return [...new Uint8Array(sig)]
            .map((b) => b.toString(16).padStart(2, '0')).join('');
        };
        const segs = new Map();
        const ivs = [];
        let tsSize = 0, covered = 0, err = null, iter = 0, example = null;
        const merge = () => {
          ivs.sort((a, b) => a[0] - b[0]);
          const m = [];
          for (const iv of ivs) {
            if (!m.length || iv[0] > m[m.length - 1][1] + 1) m.push([...iv]);
            else m[m.length - 1][1] = Math.max(m[m.length - 1][1], iv[1]);
          }
          return m;
        };
        for (; iter < maxIter; iter++) {
          const ts = Math.floor(Date.now() / 1000);
          const sign = await hmacSha1(
            `0dubox${browserid}${ts}`, 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa');
          const q = new URLSearchParams({
            uk: String(si.uk), shareid: String(si.shareid),
            type: 'M3U8_FLV_264_480', fid: String(fid),
            sign, timestamp: String(ts), jsToken: jsToken || '',
            esl: '1', isplayer: '1', ehps: '1',
            clienttype: '0', app_id: '250528', web: '1', channel: 'dubox',
          });
          const pl = await (await fetch(`/share/streaming?${q}`)).text();
          if (!pl.startsWith('#EXTM3U')) { err = pl.slice(0, 200); break; }
          if (!example) example = `/share/streaming?${q}`;
          for (const line of pl.split('\n')) {
            if (!line.startsWith('http')) continue;
            const p = new URL(line);
            const range = p.searchParams.get('range');
            if (!range || segs.has(range)) continue;
            segs.set(range, { range, url: line });
            const b = Number(range.split('-')[1]);
            ivs.push([Number(range.split('-')[0]), b]);
            tsSize = Math.max(tsSize, Number(p.searchParams.get('ts_size') || 0));
          }
          covered = merge().reduce((s, [a, b]) => s + (b - a + 1), 0);
          if (tsSize && covered >= tsSize) break;
        }
        return {
          type: 'M3U8_FLV_264_480', tsSize, covered, iterations: iter + 1,
          complete: tsSize > 0 && covered >= tsSize, error: err,
          segmentCount: segs.size, segments: [...segs.values()],
          playlistUrl: example ? new URL(example, location.origin).href : null,
        };
      }, {
        si: { shareid: cap.shareRaw.shareid, uk: cap.shareRaw.uk },
        fid, jsToken: cap.jsToken, browserid: pageEnv.browserid, maxIter,
      });

    // ---- identify videos (mediameta; fire on demand for category 1) ----
    videoFiles = [];
    for (const f of cap.files) {
      if (f.isdir === '1' || f.isdir === 1) continue;
      let meta = cap.mediaMeta[f.fs_id];
      if (!meta && String(f.category) === '1') {
        meta = await page.evaluate(async ({ si, fid, env }) => {
          const q = new URLSearchParams({
            clientfrom: 'h5', psign: '0', pcftoken: env.pcftoken,
            clienttype: '0', channel: 'dubox',
            uk: String(si.uk), shareid: String(si.shareid), fid: String(fid),
            timestamp: String(Math.floor(Date.now() / 1000)),
            app_id: '250528', web: '1', jsToken: env.jsToken,
          });
          try {
            const r = await fetch(`/share/mediameta?${q}`);
            const j = await r.json();
            return j.errno === 0 && j.duration ? j : null;
          } catch { return null; }
        }, {
          si: { shareid: cap.shareRaw.shareid, uk: cap.shareRaw.uk },
          fid: f.fs_id, env: pageEnv,
        });
        if (meta) cap.mediaMeta[f.fs_id] = meta;
      }
      if (meta && meta.duration) videoFiles.push({ file: f, meta });
    }

    mark('videos');
    // ---- original dlink attempt ---------------------------------------
    downloads = { original: null, previewHLS: [] };
    const firstFile = videoFiles[0] ? videoFiles[0].file : cap.files[0];
    const firstFid = firstFile.fs_id;
    // logged-in pages register the share to the account via
    // /share/querysurltransfer right after load — wait for that handshake
    // (plus /api/check/login) before asking for the dlink
    await waitFor(() => saw.checkLogin && saw.transfer, 12000);
    if (saw.transfer) await sleep(1500);
    mark('handshake');
    log('[terabot] attempting original dlink…');
    downloads.original = await tryOriginalDlink(firstFid);
    if (downloads.original.available) {
      log(`[terabot] original dlink OK: ` +
        `${downloads.original.dlink.slice(0, 160)}…`);
    } else {
    mark('dlink');
      log(
        `[terabot] original dlink unavailable (errno ${downloads.original.errno})` +
        `${downloads.original.errno === 2 || downloads.original.errno === 400310
          ? ' — anonymous sessions need a logged-in cookie jar (--cookies)' : ''}`);
    }

    // ---- HLS union-harvest per video ----------------------------------
    for (const { file, meta } of videoFiles) {
      log(`[terabot] harvesting HLS windows for "${file.server_filename}"…`);
      const h = await harvestHls(file.fs_id);
      if (h.error && !h.segmentCount) {
        log(`[terabot] harvest failed: ${h.error}`);
      } else {
        log(
          `[terabot] harvest: ${h.segmentCount} segments, ` +
          `${h.covered}/${h.tsSize} bytes in ${h.iterations} fetches` +
          `${h.complete ? ' (complete)' : ' (INCOMPLETE)'}`);
      }
      onProgress({
        phase: 'harvest', fid: file.fs_id, segments: h.segmentCount,
        bytes: h.covered, total: h.tsSize, complete: h.complete,
      });
      mark('harvest');
      downloads.previewHLS.push({
        fid: file.fs_id, filename: file.server_filename,
        duration: meta.duration, width: meta.width, height: meta.height,
        ...h,
        note: 'playlist serves random 30s windows; segments are the ' +
          'cookie-free signed CDN URLs covering the full 480p transcode',
      });
    }
    }   // end if (!cap) — browser extraction finished

    // ---- shared anchors (valid for both extraction paths) ---------------
    const firstFile = videoFiles[0] ? videoFiles[0].file : cap.files[0];
    const firstFid = firstFile.fs_id;

    // ---- optional download --------------------------------------------
    const written = [];
    let gotOriginal = false;

    // (A) original file via dlink — --download-original.
    // The free-tier CDN trickles ~10-50KB/s per connection, so pull the file
    // as parallel byte ranges (each through Playwright's cookie-sharing
    // request context) and refresh the ~10-min dlink when close to expiry.
    const orig = downloads.original;
    if (opts.downloadOriginal) {
      if (!opts.cookies || !orig || !orig.available || !orig.dlink) {
        log('[terabot] --download-original needs a logged-in session ' +
          '("--cookies cookies.json") and a working dlink');
        errors.push('download-original: no logged-in dlink available');
      } else {
        const expected = (orig.file_info && Number(orig.file_info.size)) ||
          Number(firstFile.size);
        const fname = firstFile.server_filename || `terabot-${firstFid}`;
        const CHUNK = 2 * 1024 * 1024;
        const POOL = 4;
        const RETRIES = 3;
        const nChunks = Math.ceil(expected / CHUNK);
        log(`[terabot] downloading ORIGINAL as ${nChunks} ranged chunks ` +
          `(free-tier CDN trickles ~50KB/s, expect a few minutes)…`);
        let dlink = orig.dlink;
        let fetched = 0;
        const t0 = Date.now();
        const parts = new Array(nChunks);
        const freshDlink = async () => {
          const exp = Number(new URL(dlink).searchParams.get('expires')) * 1000;
          if (exp - Date.now() > 120000) return dlink;
          const r = await tryOriginalDlink(firstFid);
          if (r.available && r.dlink) {
            dlink = r.dlink;
            orig.dlink = dlink;
            log('[terabot]   refreshed dlink (near 10-min expiry)');
          } else {
            log('[terabot]   dlink refresh failed — hoping the current one holds');
          }
          return dlink;
        };
        const fetchChunk = async (i) => {
          const a = i * CHUNK;
          const b = Math.min(a + CHUNK, expected) - 1;
          let err;
          for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
              const url = await freshDlink();
              const res = await ctx.request.get(url, {
                headers: {
                  'user-agent': UA,
                  referer: 'https://www.1024tera.com/',
                  range: `bytes=${a}-${b}`,
                },
                timeout: 240000,
              });
              if (res.status() !== 206 && res.status() !== 200)
                throw new Error(`HTTP ${res.status()} (expected 206)`);
              const buf = await res.body();
              if (buf.length !== b - a + 1)
                throw new Error(`got ${buf.length} bytes, expected ${b - a + 1}`);
              parts[i] = buf;
              fetched += buf.length;
              const secs = (Date.now() - t0) / 1000;
              log(`[terabot]   chunk ${i + 1}/${nChunks} ok ` +
                `(${(fetched / 1048576).toFixed(1)}/${(expected / 1048576).toFixed(1)} MB, ` +
                `${Math.round(fetched / secs / 1024)}KB/s)`);
              onProgress({
                phase: 'original', chunk: i + 1, chunks: nChunks,
                bytes: fetched, total: expected,
                kbps: Math.round(fetched / secs / 1024),
              });
              return;
            } catch (e) {
              err = e;
              if (attempt < RETRIES) await sleep(1500 * attempt);
            }
          }
          throw new Error(`chunk ${i}: ${err && err.message}`);
        };
        try {
          let next = 0;
          await Promise.all(Array.from(
            { length: Math.min(POOL, nChunks) },
            async () => {
              while (true) {
                const i = next++;
                if (i >= nChunks) return;
                await fetchChunk(i);
              }
            },
          ));
          const data = Buffer.concat(parts);
          if (data.length !== expected)
            throw new Error(`size mismatch: got ${data.length}, expected ${expected}`);
          const md5 = createHash('md5').update(data).digest('hex');
          // For videos the served bytes hash to mediameta's real_md5 (the
          // CDN's content-md5 header matches it), while file.md5 is the
          // file-record hash — accept either.
          const wantMd5s = [
            ...new Set([
              firstFile.md5,
              videoFiles[0] && videoFiles[0].meta.real_md5,
            ].filter(Boolean)),
          ];
          if (wantMd5s.length && !wantMd5s.includes(md5))
            throw new Error(
              `md5 mismatch: got ${md5}, expected one of ${wantMd5s.join(', ')}`);
          const origPath = path.join(
            opts.out, fname.replace(/[^\w.\- ()]+/g, '_'));
          writeFileSync(origPath, data);
          written.push(origPath);
          gotOriginal = true;
          orig.downloaded = {
            path: origPath, bytes: data.length, md5,
            md5ok: true, md5Matched: wantMd5s.find((m) => m === md5),
          };
          log(`[terabot] wrote ${origPath} (${data.length} bytes, md5 ok)`);
          const probe = spawnSync('ffprobe',
            ['-v', 'error', '-show_entries',
              'format=duration:stream=codec_name,width,height',
              '-of', 'json', origPath],
            { timeout: 30000, encoding: 'utf8' });
          try { orig.downloaded.ffprobe = JSON.parse(probe.stdout); } catch { /* ignore */ }
        } catch (e) {
          log(`[terabot] original download failed: ${e.message}`);
        }
      }
    }

    // (B) preview rendition — --download (fast, works anonymously)
    if (opts.download) for (const h of downloads.previewHLS) {
        if (!h.complete) {
          log(`[terabot] skip download of ${h.filename}: coverage incomplete`);
          continue;
        }
        log(`[terabot] downloading ${h.segmentCount} segments for "${h.filename}"…`);
        const buf = Buffer.alloc(h.tsSize);
        const flags = new Uint8Array(h.tsSize);
        let ok = true;
        let segDone = 0;
        let bytesDone = 0;
        for (const seg of h.segments) {
          const [a, b] = seg.range.split('-').map(Number);
          try {
            const r = await fetch(seg.url, { headers: { 'user-agent': UA } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = Buffer.from(await r.arrayBuffer());
            if (data.length !== b - a + 1)
              throw new Error(`got ${data.length} bytes, expected ${b - a + 1}`);
            data.copy(buf, a);
            flags.fill(1, a, b + 1);
            segDone++;
            bytesDone += data.length;
            onProgress({
              phase: 'preview', segment: segDone, segments: h.segmentCount,
              bytes: bytesDone, total: h.tsSize,
            });
          } catch (e) {
            log(`[terabot] segment ${seg.range} failed: ${e.message}`);
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        let missing = 0;
        for (let i = 0; i < h.tsSize; i++) if (!flags[i]) missing++;
        if (missing) {
          log(`[terabot] stitch incomplete: ${missing} bytes missing`);
          continue;
        }
        // TS alignment check: 0x47 sync byte every 188 bytes
        let bad = 0, checked = 0;
        for (let i = 0; i + 188 <= h.tsSize && checked < 5000; i += 188, checked++) {
          if (buf[i] !== 0x47) bad++;
        }
        if (bad > checked * 0.01) {
          log(`[terabot] TS sync check failed (${bad}/${checked} bad)`);
          continue;
        }
        const base = h.filename.replace(/\.[^.]+$/, '').replace(/[^\w.\- ()]+/g, '_');
        const tsPath = path.join(opts.out, `${base}.preview480.ts`);
        writeFileSync(tsPath, buf);
        written.push(tsPath);
        log(`[terabot] wrote ${tsPath} (${buf.length} bytes, TS sync ok)`);

        const mp4Path = path.join(opts.out, `${base}.preview480.mp4`);
        const ff = spawnSync('ffmpeg',
          ['-y', '-v', 'error', '-i', tsPath, '-c', 'copy',
           '-bsf:a', 'aac_adtstoasc', mp4Path],
          { timeout: 180000, encoding: 'utf8' });
        if (ff.error && ff.error.code === 'ENOENT') {
          log('[terabot] ffmpeg not found — kept .ts only');
        } else if (ff.status !== 0) {
          log(`[terabot] ffmpeg remux failed: ${(ff.stderr || '').slice(-300)}`);
        } else {
          written.push(mp4Path);
          const probe = spawnSync('ffprobe',
            ['-v', 'error', '-show_entries',
              'format=duration:stream=codec_name,width,height',
              '-of', 'json', mp4Path],
            { timeout: 30000, encoding: 'utf8' });
          let info = null;
          try { info = JSON.parse(probe.stdout); } catch { /* ignore */ }
          h.remuxed = { path: mp4Path, ffprobe: info };
          log(`[terabot] remuxed -> ${mp4Path}`);
        }
      }

    // ---- assemble metadata --------------------------------------------
    const sr = cap.shareRaw;
    let description = sr.description;
    try { description = JSON.parse(description); } catch { /* keep string */ }
    const files = cap.files.map((f) => ({
      fs_id: f.fs_id,
      name: f.server_filename,
      path: f.path,
      size: Number(f.size),
      md5: f.md5,
      emd5: f.emd5,
      category: Number(f.category),
      isdir: f.isdir === '1' || f.isdir === 1,
      ctime: Number(f.server_ctime || f.local_ctime),
      mtime: Number(f.server_mtime || f.local_mtime),
      duration: f.duration ? Number(f.duration) : undefined,
      width: f.width ? Number(f.width) : undefined,
      height: f.height ? Number(f.height) : undefined,
      rotate: f.rotate ? Number(f.rotate) : undefined,
      play_forbid: f.play_forbid,
      is_adult: f.is_adult,
      thumbs: f.thumbs,
    }));

    const metadata = {
      source: opts.url,
      fetchedAt: new Date().toISOString(),
      session: opts.cookies ? 'logged-in (cookies provided)' : 'anonymous',
      share: {
        shareid: sr.shareid,
        uk: sr.uk,
        sharer: sr.share_username,
        ctime: sr.ctime,
        fcount: sr.fcount,
        country: sr.country,
        description,
        expiredtype: sr.expiredtype,
        permanent: sr.expiredtype === 0,
        sign: sr.sign,
        timestamp: sr.timestamp,
        randsk: sr.randsk,
      },
      files,
      videos: videoFiles.map(({ file, meta }) => ({
        fid: file.fs_id,
        filename: file.server_filename,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        rotate: meta.rotate,
        real_md5: meta.real_md5,
      })),
      downloads,
      files_written: written,
      limitations: [
        'original-quality dlink requires a logged-in session ' +
          '("--cookies"; anonymous /share/download returns errno 2 / ' +
          'verify_v2)',
        'free accounts: the original-file CDN throttles to ~10-50KB/s per ' +
          'connection — use --download-original (parallel ranges) and ' +
          'expect a few minutes for tens of MB',
        'the HLS playlist serves random 30s windows — use the segment list ' +
          '(or this bot\'s --download) for the full preview rendition',
      ],
    };

    mark('total');
    log(`[terabot] timing: ${timing.join(' ')}`);

    const jsonPath = path.join(opts.out, 'metadata.json');
    writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
    log(`[terabot] metadata -> ${jsonPath}`);

    if (opts.json) {
      if (!opts.quiet) console.log(JSON.stringify(metadata, null, 2));
    } else if (!opts.quiet) {
      const v = metadata.videos[0];
      const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      console.log(`share      : ${metadata.share.sharer || '?'} — ` +
        `${metadata.share.permanent ? 'permanent link' : 'expires'}`);
      for (const f of files) {
        console.log(`file       : ${f.name}  (${(f.size / 1048576).toFixed(1)} MB)`);
      }
      if (v) console.log(`video      : ${v.duration}s, ${v.width}x${v.height}, ` +
        `md5 ${v.real_md5}`);
      const o = downloads.original;
      console.log(`original   : ${o.available
        ? o.dlink.slice(0, 160) + (o.dlink.length > 160 ? '…' : '')
        : `not available (errno ${o.errno})`}`);
      if (gotOriginal && o.downloaded)
        console.log(`original   : downloaded -> ${o.downloaded.path} ` +
          `(${(o.downloaded.bytes / 1048576).toFixed(1)} MB, md5 ok)`);
      for (const h of downloads.previewHLS) {
        console.log(`preview    : ${h.segmentCount} segments covering ` +
          `${(h.covered / 1048576).toFixed(1)}/${(h.tsSize / 1048576).toFixed(1)} MB ` +
          `480p transcode (${h.complete ? 'complete' : 'INCOMPLETE'})`);
      }
      for (const w of written) console.log(`written    : ${w}`);
    }
    const noVideo = downloads.previewHLS.length === 0;
    const downloadFailed =
      (opts.download && !written.some((p) => p.includes('.preview480'))) ||
      (opts.downloadOriginal && !gotOriginal);
    const code = (noVideo || downloadFailed) ? 1 : 0;
    return { code, metadata, written, errors };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const isMain = !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  (async () => {
    if (!cmd || cmd === 'serve' || cmd === 'server' ||
        cmd === '--port' || cmd === '--host' || cmd === '--concurrency') {
      // one command runs everything: API server (+ auto-login on boot);
      // `node terabot.mjs`, `node terabot.mjs serve …` and even
      // `node terabot.mjs --port 9000` all start it
      const { startServer } = await import('./server.mjs');
      return startServer(cmd === 'serve' || cmd === 'server'
        ? argv.slice(1) : argv);
    }
    if (cmd === 'login') {
      const { runLogin } = await import('./login.mjs');
      const ok = await runLogin({
        headful: argv.includes('--headful') || !!process.env.HEADFUL,
      });
      return process.exit(ok ? 0 : 1);
    }
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
      console.error(
        'usage: node terabot.mjs [serve [server opts]] [login] [help]\n' +
        '       node terabot.mjs [share-url] [--download] ' +
        '[--download-original] [--json] [--out DIR] [--cookies FILE] ' +
        '[--browser]');
      return;
    }
    const r = await runTerabot(parseArgs(argv));
    return process.exit(r.code ?? 0);
  })().catch((e) => {
    console.error(`[terabot] fatal: ${e.message}`);
    process.exit(1);
  });
}
