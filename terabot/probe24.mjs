// probe24.mjs — full browser-free extraction once tokens are obtained.
// HTML sources: (a) curl --http2  (b) node:http2  (c) Playwright intercept.
// For each source: get jsToken/pcftoken, then Node-fetch the whole suite:
// shorturlinfo -> list -> check/login -> mediameta -> streaming -> transfer -> download.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http2 from 'node:http2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.1024tera.com';
const SHARE = `${ORIGIN}/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg`;
const surl = 'reCn7CaS8tLmcdVMe3SYWg';
const SALT = 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa';
const { createHmac } = await import('node:crypto');

const st = JSON.parse(readFileSync(path.join(__dirname, 'cookies.json'), 'utf8'));
const cookieHeader = st.cookies
  .filter((c) => /1024tera\.com$/.test(c.domain.replace(/^\./, '')))
  .map((c) => `${c.name}=${c.value}`).join('; ');

const parseTokens = (html) => {
  const jt = (decodeURIComponent((html.match(/eval\(decodeURIComponent\(`([^`]+)`\)\)/) || [])[1] || '')
    .match(/fn\("([0-9A-F]+)"\)/) || [])[1] || '';
  const td = JSON.parse((html.match(/var templateData = (\{.*?\});<\/script>/s) ||
    html.match(/var templateData = (\{.*?\});/s) || [])[1] || '{}');
  return { jsToken: jt, pcftoken: td.pcftoken || '', bdstoken: td.bdstoken || '' };
};

const htmlViaCurl = () => {
  const out = spawnSync('curl', ['-s', '--http2', '-A', UA,
    '-H', `cookie: ${cookieHeader}`, '-H', `referer: ${SHARE}`, SHARE], { encoding: 'utf8', maxBuffer: 1 << 24 });
  return out.stdout;
};
const htmlViaHttp2 = () => new Promise((resolve, reject) => {
  const cl = http2.connect(ORIGIN);
  cl.on('error', reject);
  const req = cl.request({
    ':path': `/sharing/link?surl=${surl}`,
    ':method': 'GET',
    'user-agent': UA, cookie: cookieHeader, referer: SHARE,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1',
  });
  let body = '';
  req.on('response', (h) => {
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => { cl.close(); resolve(body); });
  });
  req.on('error', (e) => { cl.close(); reject(e); });
  req.end();
});
const htmlViaPlaywright = async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: UA, viewport: { width: 1280, height: 800 },
      storageState: path.join(__dirname, 'cookies.json'),
    });
    const page = await ctx.newPage();
    const htmlP = page.waitForResponse((r) => r.url().includes('/sharing/link?'));
    await page.goto(SHARE, { waitUntil: 'commit', timeout: 45000 });
    const html = await (await htmlP).text();
    await page.close();
    return html;
  } finally { await browser.close().catch(() => {}); }
};

const dpSession = String(Math.floor((9 * Math.random() + 1) * 1e5));
const dpUser = '00' + Math.floor((9 * Math.random() + 1) * 1e7);
let dpCount = 0;
const nextDpLogid = () => {
  dpCount = dpCount < 9999 ? dpCount + 1 : 0;
  return dpSession + dpUser + String(dpCount).padStart(4, '0');
};

const H = (extra = {}) => ({
  'user-agent': UA, cookie: cookieHeader, referer: SHARE,
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/x-www-form-urlencoded',
  'x-requested-with': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
  ...extra,
});
const common = (tok, extra = {}) => new URLSearchParams({
  clientfrom: 'h5', psign: '0', pcftoken: tok.pcftoken,
  clienttype: '0', channel: 'dubox', app_id: '250528', web: '1',
  jsToken: tok.jsToken, 'dp-logid': nextDpLogid(), ...extra,
});

async function suite(label, tok) {
  console.log(`\n===== suite ${label}: jsToken=${tok.jsToken.slice(0, 12)}… pcftoken=${tok.pcftoken.slice(0, 12)}…`);
  const out = {};
  const jget = async (p) => {
    const r = await fetch(`${ORIGIN}${p}`, { headers: H() });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { raw: t.slice(0, 100) }; }
  };
  const si = await jget(`/api/shorturlinfo?${common(tok, { shorturl: '1' + surl, root: '1', scene: '' })}`);
  out.shorturlinfo = { errno: si.errno, shareid: si.shareid, uk: si.uk, sign: si.sign ? 'yes' : 'no' };
  if (si.errno !== 0) { console.log(JSON.stringify(out)); return out; }
  const li = await jget(`/share/list?${common(tok, { page: '1', num: '20', shorturl: surl, root: '1', by: 'time', order: 'desc', scene: '' })}`);
  out.list = { errno: li.errno ?? li.code, files: li.list?.length ?? 0 };
  const f0 = (li.list || [])[0] || {};
  const cl = await jget(`/api/check/login?${common(tok)}`);
  out.checkLogin = { errno: cl.errno, uk: cl.uk };
  const mm = await jget(`/share/mediameta?${common(tok, { uk: String(si.uk), shareid: String(si.shareid), fid: String(f0.fs_id), timestamp: String(si.timestamp) })}`);
  out.mediameta = { errno: mm.errno, duration: mm.duration };
  // streaming (1 window)
  const ts = Math.floor(Date.now() / 1000);
  const browserid = (cookieHeader.match(/browserid=([^;]+)/) || [])[1] || '';
  const sign = createHmac('sha1', SALT).update(`0dubox${browserid}${ts}`).digest('hex');
  const sq = new URLSearchParams({
    uk: String(si.uk), shareid: String(si.shareid), type: 'M3U8_FLV_264_480',
    fid: String(f0.fs_id), sign, timestamp: String(ts), jsToken: tok.jsToken,
    esl: '1', isplayer: '1', ehps: '1', clienttype: '0', app_id: '250528',
    web: '1', channel: 'dubox',
  });
  const sr = await fetch(`${ORIGIN}/share/streaming?${sq}`, { headers: H() });
  const pl = await sr.text();
  out.streaming = { m3u8: pl.startsWith('#EXTM3U'), segs: pl.split('\n').filter((l) => l.startsWith('http')).length };
  // transfer
  const tr = await fetch(`${ORIGIN}/share/querysurltransfer?${common(tok, { bdstoken: tok.bdstoken || '' })}`, {
    method: 'POST', headers: H(),
    body: new URLSearchParams({ sid: String(si.shareid), suk: String(si.uk) }).toString(),
  });
  out.transfer = await tr.json().catch(() => ({}));
  out.transfer = { errno: out.transfer.errno, has_transferred: out.transfer.data?.has_transferred };
  // download
  const dr = await fetch(`${ORIGIN}/share/download?${common(tok, {
    scene: 'purchased_list', shareid: String(si.shareid), sign: si.sign || '',
    timestamp: String(si.timestamp), bdstoken: tok.bdstoken || '',
  })}`, {
    method: 'POST',
    headers: H({ 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
    body: new URLSearchParams({
      product: 'share', nozip: '0',
      fid_list: JSON.stringify([String(f0.fs_id)]),
      uk: String(si.uk), primaryid: String(si.shareid),
    }).toString(),
  });
  const dj = await dr.json().catch(() => ({}));
  out.download = { errno: dj.errno, available: !!dj.dlink, dlink: dj.dlink ? dj.dlink.slice(0, 60) + '…' : null };
  console.log(JSON.stringify(out, null, 1));
  return out;
}

// (a) curl HTML
try {
  const tok = parseTokens(htmlViaCurl());
  console.log(`[curl html] ${tok.jsToken ? 'jsToken ok' : 'NO jsToken'}`);
  if (tok.jsToken) await suite('A curl-h2-html', tok);
} catch (e) { console.log('curl html failed:', e.message); }

// (b) node http2 HTML
try {
  const tok = parseTokens(await htmlViaHttp2());
  console.log(`[node:h2 html] ${tok.jsToken ? 'jsToken ok' : 'NO jsToken'}`);
  if (tok.jsToken) await suite('B node-h2-html', tok);
} catch (e) { console.log('node:h2 html failed:', e.message); }

// (c) playwright HTML (known-good baseline)
try {
  const tok = parseTokens(await htmlViaPlaywright());
  console.log(`[pw html] ${tok.jsToken ? 'jsToken ok' : 'NO jsToken'}`);
  if (tok.jsToken) await suite('C playwright-html', tok);
} catch (e) { console.log('pw html failed:', e.message); }
