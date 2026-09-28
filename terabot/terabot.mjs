#!/usr/bin/env node
// terabot.mjs — TeraBox share bot
// Opens a 1024tera.com / TeraBox share link, extracts video metadata and
// download links, and optionally downloads the full preview rendition.
//
//   node terabot.mjs [share-url] [--download] [--download-original]
//                    [--json] [--out DIR] [--cookies FILE]
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
//                       session (create with `node login.mjs`); anonymous
//                       sessions get errno 2 / "need verify_v2" from
//                       /share/download
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

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    out: path.join(__dirname, 'output'), cookies: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--download') opts.download = true;
    else if (a === '--download-original') opts.downloadOriginal = true;
    else if (a === '--json') opts.json = true;
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

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      ...(opts.cookies && existsSync(opts.cookies)
        ? { storageState: opts.cookies }
        : {}),
    });
    const page = await ctx.newPage();

    // ---- capture hooks ------------------------------------------------
    const cap = {
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
    const got = await waitFor(() => cap.shareRaw && cap.files.length > 0, 20000);
    if (!got) {
      const title = await page.title().catch(() => '?');
      throw new Error(
        `share data did not load within 20s (title: ${title}) — ` +
        `link expired, deleted, or region-blocked?`,
      );
    }
    if (!cap.jsToken) cap.jsToken = await page.evaluate(() => window.jsToken || null);

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

    // exact frontend shape for /share/download — the Wt wrapper used by the
    // Download button (scene=purchased_list); the os wrapper (scene="") gets
    // errno 14 even when logged in
    const tryOriginalDlink = (fid) =>
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
    const videoFiles = [];
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

    // ---- original dlink attempt ---------------------------------------
    const downloads = { original: null, previewHLS: [] };
    const firstFile = videoFiles[0] ? videoFiles[0].file : cap.files[0];
    const firstFid = firstFile.fs_id;
    // logged-in pages register the share to the account via
    // /share/querysurltransfer right after load — wait for that handshake
    // (plus /api/check/login) before asking for the dlink
    await waitFor(() => saw.checkLogin && saw.transfer, 12000);
    if (saw.transfer) await sleep(1500);
    log('[terabot] attempting original dlink…');
    downloads.original = await tryOriginalDlink(firstFid);
    if (downloads.original.available) {
      log(`[terabot] original dlink OK: ` +
        `${downloads.original.dlink.slice(0, 160)}…`);
    } else {
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
      downloads.previewHLS.push({
        fid: file.fs_id, filename: file.server_filename,
        duration: meta.duration, width: meta.width, height: meta.height,
        ...h,
        note: 'playlist serves random 30s windows; segments are the ' +
          'cookie-free signed CDN URLs covering the full 480p transcode',
      });
    }

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
    await browser.close().catch(() => {});
  }
}

const isMain = !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runTerabot(parseArgs(process.argv.slice(2)))
    .then((r) => process.exit(r.code ?? 0))
    .catch((e) => {
      console.error(`[terabot] fatal: ${e.message}`);
      process.exit(1);
    });
}
