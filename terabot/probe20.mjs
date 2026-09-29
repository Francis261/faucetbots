// probe20.mjs — browser-free extraction test.
// Every endpoint the Playwright flow uses, called with plain fetch:
//   HTML (jsToken/templateData) -> shorturlinfo -> list -> mediameta
//   -> streaming (HMAC) -> querysurltransfer -> download (dlink)
// Run: node probe20.mjs [--cookies cookies.json]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const SALT = 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa';
const SHARE = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const cookiesArg = process.argv.indexOf('--cookies');
const cookiesFile = cookiesArg >= 0
  ? process.argv[cookiesArg + 1]
  : path.join(__dirname, 'cookies.json');

const t0 = Date.now();
const ms = () => `${Date.now() - t0}ms`;
const log = (...a) => console.error(`[${ms()}]`, ...a);

// ---- cookie jar --------------------------------------------------------
const jar = new Map();
if (process.argv.includes('--cookies') || process.argv.includes('--anon') !== true) {
  // default: use cookies.json when present
}
try {
  const st = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  for (const c of st.cookies || []) {
    if (/(^|\.)1024tera\.com$/.test(c.domain.replace(/^\./, ''))) jar.set(c.name, c.value);
  }
  log(`loaded ${jar.size} cookies from ${cookiesFile}: ${[...jar.keys()].join(',')}`);
} catch (e) { log(`no cookies (${e.code || e.message}) — anonymous`); }
let cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const absorb = (res) => {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
};
const H = (extra = {}) => ({
  'user-agent': UA, cookie: cookieHeader, referer: SHARE,
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/x-www-form-urlencoded',
  'x-requested-with': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  ...extra,
});

// ---- 1. HTML ------------------------------------------------------------
let r = await fetch(SHARE, { headers: { 'user-agent': UA, referer: SHARE } });
absorb(r);
const html = await r.text();
log(`HTML ${html.length}B status=${r.status} cookies=[${[...jar.keys()].join(',')}]`);

const jtM = html.match(/eval\(decodeURIComponent\(`([^`]+)`\)\)/);
const jsToken = jtM ? (decodeURIComponent(jtM[1]).match(/fn\("([0-9A-F]+)"\)/) || [])[1] : null;
log('jsToken:', jsToken ? `${jsToken.slice(0, 24)}… (${jsToken.length})` : 'NOT FOUND');

const tdM = html.match(/var templateData = (\{.*?\});<\/script>/s) ||
  html.match(/var templateData = (\{.*?\});/s);
const td = tdM ? JSON.parse(tdM[1]) : {};
log('templateData:', JSON.stringify({ bdstoken: td.bdstoken, pcftoken: td.pcftoken }).slice(0, 200));
const dpLogidSrc = (html.match(/dp-logid=(\d+)/) || [])[1] || '';
// dp-logid per frontend dplogid-2.0.3: sessionId(6) + "00"+8digits + counter(4)
const dpSession = String(Math.floor((9 * Math.random() + 1) * 1e5));
const dpUser = '00' + Math.floor((9 * Math.random() + 1) * 1e7);
let dpCount = 0;
const nextDpLogid = () => {
  dpCount = dpCount < 9999 ? dpCount + 1 : 0;
  return dpSession + dpUser + String(dpCount).padStart(4, '0');
};
const dpLogid = nextDpLogid();
log('dp-logid (generated):', dpLogid, '(og:image had', dpLogidSrc + ')');

const surl = new URL(SHARE).searchParams.get('surl');
const common = (extra = {}) => new URLSearchParams({
  clientfrom: 'h5', psign: '0', pcftoken: td.pcftoken || '',
  clienttype: '0', channel: 'dubox', app_id: '250528', web: '1',
  jsToken: jsToken || '', 'dp-logid': nextDpLogid(), ...extra,
});

// ---- 2. shorturlinfo ----------------------------------------------------
for (const shorturl of [surl, '1' + surl]) {
  const q = common({ shorturl, root: '1', scene: '' });
  r = await fetch(`https://www.1024tera.com/api/shorturlinfo?${q}`, { headers: H() });
  absorb(r);
  const j = await r.json().catch(() => ({}));
  log(`shorturlinfo shorturl=${shorturl.slice(0, 12)}… -> errno=${j.errno} ` +
    `sign=${j.sign ? 'yes' : 'no'} shareid=${j.shareid} uk=${j.uk} fcount=${j.fcount}`);
  if (j.errno === 0) { var si = j; break; }
}
if (!si) throw new Error('shorturlinfo failed');

// ---- 3b. check/login (bdstoken source?) --------------------------------
r = await fetch(`https://www.1024tera.com/api/check/login?${common()}`, { headers: H() });
absorb(r);
const clj = await r.json().catch(() => ({}));
log(`check/login -> ${JSON.stringify(clj).slice(0, 300)}`);

// ---- 3. list ------------------------------------------------------------
const lq = common({
  page: '1', num: '20', shorturl: surl, root: '1', by: 'time', order: 'desc', scene: '',
});
r = await fetch(`https://www.1024tera.com/share/list?${lq}`, { headers: H() });
absorb(r);
const lraw = await r.text();
log(`list raw status=${r.status}: ${lraw.slice(0, 300)}`);
const lj = (() => { try { return JSON.parse(lraw); } catch { return {}; } })();
log(`list -> errno=${lj.errno} files=${Array.isArray(lj.list) ? lj.list.length : 0}`);
const files = lj.list || [];
const f0 = files[0] || {};
log('file0:', f0.server_filename, 'fs_id=' + f0.fs_id, 'cat=' + f0.category, 'size=' + f0.size);

// ---- 4. mediameta -------------------------------------------------------
const mq = common({
  uk: String(si.uk), shareid: String(si.shareid), fid: String(f0.fs_id),
  timestamp: String(si.timestamp),
});
r = await fetch(`https://www.1024tera.com/share/mediameta?${mq}`, { headers: H() });
absorb(r);
const mj = await r.json().catch(() => ({}));
log(`mediameta -> errno=${mj.errno} duration=${mj.duration} ${mj.width}x${mj.height} real_md5=${(mj.real_md5 || '').slice(0, 12)}…`);

// ---- 5. streaming (1 window) -------------------------------------------
const browserid = jar.get('browserid') || '';
log('browserid:', browserid ? browserid.slice(0, 16) + '…' : 'MISSING');
const streamQ = new URLSearchParams({
  uk: String(si.uk), shareid: String(si.shareid), type: 'M3U8_FLV_264_480',
  fid: String(f0.fs_id),
  sign: createHmac('sha1', SALT).update(`0dubox${browserid}${Math.floor(Date.now() / 1000)}`).digest('hex'),
  timestamp: String(Math.floor(Date.now() / 1000)),
  jsToken: jsToken || '', esl: '1', isplayer: '1', ehps: '1',
  clienttype: '0', app_id: '250528', web: '1', channel: 'dubox',
});
r = await fetch(`https://www.1024tera.com/share/streaming?${streamQ}`, { headers: H() });
absorb(r);
const pl = await r.text();
const segs = pl.split('\n').filter((l) => l.startsWith('http'));
log(`streaming status=${r.status} ${pl.startsWith('#EXTM3U') ? 'M3U8 ok' : 'NOT M3U8: ' + pl.slice(0, 150)} segs=${segs.length}`);
if (segs[0]) {
  const u = new URL(segs[0]);
  log('segment0 range=', u.searchParams.get('range'), 'ts_size=', u.searchParams.get('ts_size'));
  const sr = await fetch(segs[0], { headers: { 'user-agent': UA, range: 'bytes=0-65535' } });
  const sb = Buffer.from(await sr.arrayBuffer());
  log(`segment fetch status=${sr.status} ${sb.length}B sync0=0x${sb[0].toString(16)}`);
}

// ---- 6. querysurltransfer ----------------------------------------------
const tq = common({ bdstoken: td.bdstoken || '' });
const tbody = new URLSearchParams({
  sid: String(si.shareid), suk: String(si.uk),
});
{
  const res = await fetch(`https://www.1024tera.com/share/querysurltransfer?${tq}`, {
    method: 'POST',
    headers: H({ 'content-type': 'application/x-www-form-urlencoded' }),
    body: tbody.toString(),
  });
  const txt = await res.text();
  log(`transfer POST sid/suk status=${res.status} -> ${txt.slice(0, 220)}`);
}

// ---- 7. download (dlink) ------------------------------------------------
const bdToken = clj.bdstoken || td.bdstoken || '';
log('using bdstoken:', bdToken ? bdToken.slice(0, 16) + '…' : 'EMPTY');
const dq = common({
  scene: 'purchased_list', shareid: String(si.shareid), sign: si.sign || '',
  timestamp: String(si.timestamp), bdstoken: bdToken,
});
const dbody = new URLSearchParams({
  product: 'share', nozip: '0',
  fid_list: JSON.stringify([String(f0.fs_id)]),
  uk: String(si.uk), primaryid: String(si.shareid),
});
r = await fetch(`https://www.1024tera.com/share/download?${dq}`, {
  method: 'POST',
  headers: H({ 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
  body: dbody.toString(),
});
absorb(r);
const dj = await r.json().catch(() => ({}));
log(`download -> status=${r.status} errno=${dj.errno} available=${!!dj.dlink} ` +
  `dlink=${dj.dlink ? dj.dlink.slice(0, 80) + '…' : JSON.stringify(dj).slice(0, 200)}`);
if (dj.dlink) {
  const dr = await fetch(dj.dlink, { headers: { 'user-agent': UA, referer: SHARE, cookie: cookieHeader } });
  log(`dlink fetch status=${dr.status} len=${dr.headers.get('content-length')} type=${dr.headers.get('content-type')}`);
}
log('DONE');
