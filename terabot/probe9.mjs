// probe9.mjs — fetch same playlist 5x, compare windows; check determinism
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
  const browserid = document.cookie.match(/browserid=([^;]+)/)?.[1] || '';
  const hmacSha1 = async (msg, key) => {
    const enc = new TextEncoder();
    const ck = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(msg));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmacSha1(`0dubox${browserid}${ts}`, 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa');
  const mk = (extra = {}) => new URLSearchParams({ uk: String(si.uk), shareid: String(si.shareid), type: 'M3U8_FLV_264_480', fid: '558462010993370', sign, timestamp: String(ts), jsToken, esl: '1', isplayer: '1', ehps: '1', clienttype: '0', app_id: '250528', web: '1', channel: 'dubox', ...extra });
  const fetchRanges = async (q) => {
    const pl = await (await fetch(`/share/streaming?${q}`)).text();
    if (!pl.startsWith('#EXTM3U')) return pl.slice(0, 150);
    return pl.split('\n').filter(l => l.startsWith('http')).map(u => new URL(u).searchParams.get('range')).join(' | ');
  };
  const res = { same: [], withStart: [], withSeq: [] };
  for (let i = 0; i < 5; i++) res.same.push(await fetchRanges(mk()));
  await new Promise(r => setTimeout(r, 1500));
  res.same2 = await fetchRanges(mk());
  res.withStart = await fetchRanges(mk({ start: '0' }));
  res.withSeq = await fetchRanges(mk({ seq: '0', start_ply: '0' }));
  return res;
}, { si, jsToken });
console.log(JSON.stringify(out, null, 1));
await browser.close();
