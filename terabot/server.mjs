#!/usr/bin/env node
// server.mjs — REST API for terabot
//
//   node terabot.mjs serve [--port 8788] [--host 127.0.0.1] [--out DIR]
//                          [--cookies FILE] [--concurrency N]
//   (running `node server.mjs …` directly works too)
//
// Endpoints (JSON, CORS enabled):
//   GET    /                    endpoint index
//   GET    /health              liveness + session/job counters
//   POST   /api/info            {url?} -> 200 (one synchronous call: metadata
//                                  + download_url + stream_url/segments;
//                                  typically ~3-8 s via the fast path)
//   POST   /api/extract         {url?} -> 202 {id}     metadata + links (job)
//   POST   /api/download        {url?, mode} -> 202 {id}
//                                  mode "preview"  — fast 480p transcode
//                                  mode "original" — original file, needs the
//                                    logged-in cookies file (~10 min / 30 MB
//                                    on free accounts)
//   GET    /api/jobs            job summaries (newest first)
//   GET    /api/jobs/:id        full job: status, progress, logs, result
//   DELETE /api/jobs/:id        cancel a queued job (409 if running)
//   GET    /api/metadata?url=   synchronous shortcut -> metadata JSON
//                                 (waits for its queue slot)
//   GET    /api/files           list files in the output directory
//   GET    /api/files/:name     download a file
//
// Jobs run through a queue (default concurrency 1).  Extraction is
// browser-free on the fast path (a Playwright fallback is used only if it
// fails, or for --download-original).  On boot the server auto-runs the
// login flow when .account.json exists but cookies.json does not.
// The server binds localhost only unless --host says otherwise; there is no
// auth, so do not expose it publicly.

import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTerabot, DEFAULT_URL } from './terabot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT) || 8788,
    host: '127.0.0.1',
    out: path.join(__dirname, 'output'),
    cookies: null,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--cookies') opts.cookies = path.resolve(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return opts;
}
let opts = null;
let cookiesPath = null;
const sessionPresent = () =>
  existsSync(cookiesPath || path.join(__dirname, 'cookies.json'));

// ---------------------------------------------------------------- jobs
const jobs = new Map();      // id -> job
const MAX_LOGS = 300;
const MAX_JOBS = 100;

function makeJob(type, mode, url) {
  const job = {
    id: randomUUID().slice(0, 8),
    type,                       // 'extract' | 'download'
    mode: mode || null,         // 'preview' | 'original'
    url: url || DEFAULT_URL,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    errors: [],
    progress: null,
    logs: [],
    result: null,               // { metadata, files } once done
  };
  job.settled = new Promise((resolve) => { job._settle = resolve; });
  jobs.set(job.id, job);
  // cap job history (oldest non-active jobs get dropped)
  if (jobs.size > MAX_JOBS) {
    for (const [id, j] of jobs) {
      if (jobs.size <= MAX_JOBS) break;
      if (j.status === 'queued' || j.status === 'running') continue;
      jobs.delete(id);
    }
  }
  return job;
}

const pushLog = (job, msg) => {
  const line = typeof msg === 'string' ? msg : String(msg);
  job.logs.push(line);
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
};

const queue = [];
let active = 0;

async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  console.error(`[api] job ${job.id} (${job.type}${job.mode ? ':' + job.mode : ''}) start`);
  const wantOriginal = job.type === 'download' && job.mode === 'original';
  const wantPreview = job.type === 'download' && job.mode !== 'original';
  try {
    const r = await runTerabot({
      url: job.url,
      out: opts.out,
      cookies: sessionPresent() ? cookiesPath : null,
      download: wantPreview,
      downloadOriginal: wantOriginal,
      json: false,
      quiet: true,
    }, {
      log: (m) => {
        pushLog(job, m);
        console.error(`[api] job ${job.id} ${m}`);
      },
      onProgress: (p) => { job.progress = { ...p, at: new Date().toISOString() }; },
    });
    job.exitCode = r.code;
    job.errors = r.errors || [];
    job.result = { ...infoOf(r.metadata), files: r.written };
    const failed = r.code !== 0 && job.type === 'download';
    job.status = failed ? 'failed' : 'done';
    if (failed) job.error = `download failed (exit ${r.code}) — see logs`;
    if (r.errors && r.errors.length && !job.error) job.error = r.errors.join('; ');
  } catch (e) {
    job.status = 'failed';
    job.error = String(e && e.message || e).slice(0, 500);
    pushLog(job, `[api] FATAL: ${job.error}`);
  }
  job.finishedAt = new Date().toISOString();
  console.error(`[api] job ${job.id} ${job.status}${job.error ? ` — ${job.error}` : ''}`);
  job._settle(job);
}

function pump() {
  while (active < opts.concurrency && queue.length) {
    const job = queue.shift();
    if (job.status === 'cancelled') { job._settle(job); continue; }
    active++;
    runJob(job).finally(() => { active--; pump(); });
  }
}

function enqueue(job) {
  queue.push(job);
  pump();
  return job;
}

// ---------------------------------------------------------------- http
const TYPE_BY_EXT = {
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const jobSummary = (j) => ({
  id: j.id, type: j.type, mode: j.mode, url: j.url, status: j.status,
  createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  error: j.error, progress: j.progress,
});
const jobFull = (j) => ({
  ...jobSummary(j), exitCode: j.exitCode, errors: j.errors,
  progress: j.progress, logs: j.logs, result: j.result,
});

// Flatten the three things callers ask for into one envelope around the
// full metadata: download_url (original dlink), stream_url (HLS playlist
// window) + stream_segments (direct CDN links, ~8h validity).
function infoOf(metadata) {
  const d = (metadata.downloads && metadata.downloads.original) || {};
  const h = ((metadata.downloads && metadata.downloads.previewHLS) || [])[0] || null;
  const v = (metadata.videos && metadata.videos[0]) || null;
  const file = ((metadata.files || []).find((f) => v && f.fs_id === v.fid)) ||
    (metadata.files || [])[0] || null;
  let downloadExpiresAt = null;
  if (d.dlink) {
    try {
      const ex = new URL(d.dlink).searchParams.get('expires');
      if (ex) downloadExpiresAt = new Date(Number(ex) * 1000).toISOString();
    } catch { /* ignore */ }
  }
  return {
    url: metadata.source,
    video: v ? {
      fid: v.fid, filename: v.filename, duration: v.duration,
      width: v.width, height: v.height,
      size: file ? file.size : null,
      md5: v.real_md5 || (file && file.md5) || null,
    } : null,
    download_url: d.available ? d.dlink : null,
    download_available: !!d.available,
    download_errno: d.errno ?? null,
    download_expires_at: downloadExpiresAt,
    download_size: (d.file_info && Number(d.file_info.size)) ||
      (file ? file.size : null),
    stream_url: h ? h.playlistUrl : null,
    stream_type: h ? h.type : null,
    stream_bytes: h ? h.tsSize : null,
    stream_complete: h ? h.complete : null,
    stream_segments: h ? h.segments.map((s) => ({ range: s.range, url: s.url })) : [],
    stream_note: h ? h.note : null,
    metadata,
  };
}

const badUrl = (u) => u != null && !/^https?:\/\//i.test(String(u));
const bodyOf = async (req) => {
  const raw = await readBody(req).catch(() => '');
  try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
};

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  // ---- index / health
  if (req.method === 'GET' && p === '/') return sendJson(res, 200, {
    service: 'terabot-api',
    endpoints: {
      'GET /health': 'liveness + session/job counters',
      'POST /api/info': '{url?} -> 200  ONE call: metadata + download_url + stream_url (typically ~3-8s)',
      'POST /api/extract': '{url?} -> 202 {id}  metadata + links job',
      'POST /api/download': '{url?, mode: "preview"|"original"} -> 202 {id}',
      'GET /api/jobs': 'job summaries (newest first)',
      'GET /api/jobs/:id': 'full job incl. logs, progress, result',
      'DELETE /api/jobs/:id': 'cancel a queued job',
      'GET /api/metadata?url=': 'synchronous metadata shortcut',
      'GET /api/files': 'list output files',
      'GET /api/files/:name': 'download a file',
    },
  });
  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, {
    ok: true,
    session: sessionPresent() ? 'logged-in cookies present' : 'anonymous',
    out: opts.out,
    jobs: {
      total: jobs.size,
      active,
      queued: queue.filter((j) => j.status === 'queued').length,
    },
  });

  // ---- jobs
  if (p === '/api/extract' && req.method === 'POST') {
    const b = await bodyOf(req);
    if (b === null) return sendJson(res, 400, { error: 'invalid JSON' });
    if (badUrl(b.url)) return sendJson(res, 400, { error: 'url must be http(s)' });
    const job = enqueue(makeJob('extract', null, b.url));
    return sendJson(res, 202, { id: job.id, status: job.status });
  }
  if (p === '/api/download' && req.method === 'POST') {
    const b = await bodyOf(req);
    if (b === null) return sendJson(res, 400, { error: 'invalid JSON' });
    if (badUrl(b.url)) return sendJson(res, 400, { error: 'url must be http(s)' });
    const mode = b.mode === 'original' ? 'original' : 'preview';
    if (mode === 'original' && !sessionPresent()) {
      return sendJson(res, 400, {
        error: 'original download needs a logged-in session — run `node login.mjs` first',
      });
    }
    const job = enqueue(makeJob('download', mode, b.url));
    return sendJson(res, 202, { id: job.id, status: job.status, mode });
  }

  // ---- single-call info: metadata + download_url + stream_url in one JSON
  if (p === '/api/info' && req.method === 'POST') {
    const b = await bodyOf(req);
    if (b === null) return sendJson(res, 400, { error: 'invalid JSON' });
    if (badUrl(b.url)) return sendJson(res, 400, { error: 'url must be http(s)' });
    const job = enqueue(makeJob('extract', null, b.url));
    const settled = await job.settled;
    if (settled.status === 'cancelled') return sendJson(res, 409, { error: 'cancelled' });
    if (!settled.result) {
      return sendJson(res, 502, {
        error: settled.error || 'extract failed', logs: settled.logs.slice(-30),
      });
    }
    return sendJson(res, 200, { job_id: job.id, ...settled.result });
  }
  if (p === '/api/jobs' && req.method === 'GET') {
    const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sendJson(res, 200, { jobs: list.map(jobSummary) });
  }
  const jm = p.match(/^\/api\/jobs\/([\w-]+)$/);
  if (jm) {
    const job = jobs.get(jm[1]);
    if (!job) return sendJson(res, 404, { error: 'no such job' });
    if (req.method === 'GET') return sendJson(res, 200, jobFull(job));
    if (req.method === 'DELETE') {
      if (job.status !== 'queued') return sendJson(res, 409, { error: `job is ${job.status}` });
      job.status = 'cancelled';
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      job._settle(job);
      return sendJson(res, 200, { id: job.id, status: 'cancelled' });
    }
  }

  // ---- synchronous metadata shortcut (same envelope as POST /api/info;
  //      prefer POST /api/info with the url in the payload)
  if (p === '/api/metadata' && req.method === 'GET') {
    const job = enqueue(makeJob('extract', null, u.searchParams.get('url')));
    const settled = await job.settled;
    if (settled.status === 'cancelled') return sendJson(res, 409, { error: 'cancelled' });
    if (!settled.result) return sendJson(res, 502, { error: settled.error || 'extract failed', logs: settled.logs.slice(-30) });
    return sendJson(res, 200, { job_id: job.id, ...settled.result });
  }

  // ---- files
  if (p === '/api/files' && req.method === 'GET') {
    let names = [];
    try { names = readdirSync(opts.out); } catch { /* dir missing */ }
    const files = names
      .filter((n) => !n.startsWith('.'))
      .map((n) => {
        try {
          const st = statSync(path.join(opts.out, n));
          if (!st.isFile()) return null;
          return {
            name: n, size: st.size, mtime: st.mtime.toISOString(),
            url: `/api/files/${encodeURIComponent(n)}`,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    return sendJson(res, 200, { dir: opts.out, files });
  }
  const fm = p.match(/^\/api\/files\/(.+)$/);
  if (fm && req.method === 'GET') {
    const name = decodeURIComponent(fm[1]);
    const full = path.resolve(opts.out, name);
    if (full !== path.resolve(opts.out) && !full.startsWith(path.resolve(opts.out) + path.sep)) {
      return sendJson(res, 400, { error: 'invalid path' });
    }
    if (!existsSync(full) || !statSync(full).isFile())
      return sendJson(res, 404, { error: 'no such file' });
    const st = statSync(full);
    res.writeHead(200, {
      'content-type': TYPE_BY_EXT[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': `attachment; filename="${name.replace(/[^\w.\- ()]+/g, '_')}"`,
      'access-control-allow-origin': '*',
    });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(full).pipe(res);
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- boot
// Auto-login: a fresh checkout has .account.json (gitignored) but no
// cookies.json — `node terabot.mjs` then logs in on its own so every
// endpoint immediately serves logged-in dlinks.
async function maybeAutoLogin() {
  const account = path.join(__dirname, '.account.json');
  if (sessionPresent() || !existsSync(account)) return;
  console.error('[api] no cookies.json — logging in (.account.json present)…');
  try {
    const { runLogin } = await import('./login.mjs');
    const ok = await runLogin({ headful: false });
    console.error(ok
      ? '[api] login OK — logged-in dlinks enabled'
      : '[api] login FAILED — running anonymous (extract still works)');
  } catch (e) {
    console.error(`[api] auto-login error: ${e.message} — running anonymous`);
  }
}

export function startServer(argv = []) {
  opts = parseArgs(argv);
  cookiesPath = opts.cookies || path.join(__dirname, 'cookies.json');

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { sendJson(res, 500, { error: String(e && e.message || e) }); } catch { /* gone */ }
    });
  });

  server.listen(opts.port, opts.host, () => {
    console.error(`[api] terabot REST API on http://${opts.host}:${opts.port}`);
    console.error(`[api] out=${opts.out} session=${sessionPresent() ? cookiesPath : 'anonymous'} concurrency=${opts.concurrency}`);
    maybeAutoLogin();
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.error(`[api] ${sig} — shutting down (in-flight jobs are aborted; chromium may take a moment)`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
  return server;
}

const isMain = !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer(process.argv.slice(2));
