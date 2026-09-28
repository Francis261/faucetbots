// probe7.mjs — playlist via computed sign; test single-request full transcode fetch
import { chromium } from 'playwright';
const URL_ = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
let jsToken = null, si = null;
page.on('request', (req) => { const m = req.url().match(/jsToken=([A-F0-9]+)/); if (m && !jsToken) jsToken = m[1]; });
page.on('response', async (res) => {
  if (res.url().includes('/api/shorturlinfo')) { try { const j = await res.json(); if (j.errno === 0 && j.sign) si = { sign: j.sign, timestamp: j.timestamp, shareid: j.shareid, uk: j.uk }; } catch {} }
});
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(6000);

const out = await page.evaluate(async ({ si, jsToken }) => {
  const res = {};
  const browserid = document.cookie.match(/browserid=([^;]+)/)?.[1] || '';
  const hmacSha1 = async (msg, key) => {
    const enc = new TextEncoder();
    const ck = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(msg));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmacSha1(`0dubox${browserid}${ts}`, 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa');
  const q = new URLSearchParams({ uk: String(si.uk), shareid: String(si.shareid), type: 'M3U8_FLV_264_480', fid: '558462010993370', sign, timestamp: String(ts), jsToken, esl: '1', isplayer: '1', ehps: '1', clienttype: '0', app_id: '250528', web: '1', channel: 'dubox' });
  const pl = await (await fetch(`/share/streaming?${q}`)).text();
  if (!pl.startsWith('#EXTM3U')) return { err: 'bad playlist', pl: pl.slice(0, 200) };
  const lines = pl.split('\n');
  const segs = lines.filter(l => l.startsWith('http'));
  res.segments = segs.length;
  const u = new URL(segs[0]);
  const rangeInUrl = u.searchParams.get('range');
  res.range_param = rangeInUrl;
  // probe actual size of the whole transcode file
  const u2 = new URL(segs[0]); u2.searchParams.delete('range');
  const rh = await fetch(u2, { headers: { Range: 'bytes=0-0' } });
  res.whole_file_probe = { status: rh.status, content_range: rh.headers.get('content-range'), ct: rh.headers.get('content-type') };
  // fetch the whole thing (capped check: content-length only)
  const rf = await fetch(u2);
  res.full_fetch = { status: rf.status, cl: rf.headers.get('content-length'), ct: rf.headers.get('content-type') };
  if (rf.ok) {
    const buf = new Uint8Array(await rf.arrayBuffer());
    res.full_fetch.bytes = buf.length;
    res.full_fetch.first8 = [...buf.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
    res.full_fetch.is_ts = buf[0] === 0x47;
  }
  // does segment-range fetch work too (exact playlist URL)?
  const rr = await fetch(segs[0]);
  res.segment_fetch = { status: rr.status, cl: rr.headers.get('content-length') };
  return res;
}, { si, jsToken });

console.log(JSON.stringify(out, null, 2));
await browser.close();
