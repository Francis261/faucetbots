// probe5.mjs — quality variants + segment fetch test (all in-page, same session)
import { chromium } from 'playwright';
const URL_ = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
let jsToken = null, si = null, streamingUrl480 = null;
page.on('request', (req) => { const m = req.url().match(/jsToken=([A-F0-9]+)/); if (m && !jsToken) jsToken = m[1]; });
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/shorturlinfo')) { try { const j = await res.json(); if (j.errno === 0 && j.sign) si = { sign: j.sign, timestamp: j.timestamp, shareid: j.shareid, uk: j.uk }; } catch {} }
  if (u.includes('type=M3U8_FLV_264_480') && !streamingUrl480) streamingUrl480 = u;
});
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(7000);
// trigger the player once so it fetches the480 playlist (gives us a live playlist to test segments)
await page.locator('video').first().click({ timeout: 4000 }).catch(()=>{});
await page.waitForTimeout(6000);

const out = await page.evaluate(async ({ si, jsToken, streamingUrl480 }) => {
  const res = {};
  const types = ['M3U8_FLV_264_360', 'M3U8_AUTO_360', 'M3U8_AUTO_4K', 'M3U8_FLV_264_720', 'M3U8_FLV_264_1080', 'M3U8_ORI', 'M3U8_AUTO_480'];
  for (const ty of types) {
    const u = new URL(location.origin + '/share/streaming');
    u.search = new URLSearchParams({ uk: String(si.uk), shareid: String(si.shareid), type: ty, fid: '558462010993370', sign: si.sign, timestamp: String(si.timestamp), jsToken, esl: '1', isplayer: '1', ehps: '1', clienttype: '0', app_id: '250528', web: '1', channel: 'dubox' }).toString();
    try {
      const r = await fetch(u); const t = await r.text();
      res[ty] = { status: r.status, ct: r.headers.get('content-type'), head: t.slice(0, 300) };
    } catch (e) { res[ty] = { err: String(e).slice(0, 120) }; }
  }
  // segment test: fetch the live480 playlist, grab first segment, HEAD/GET it
  if (streamingUrl480) {
    try {
      const pl = await (await fetch(streamingUrl480)).text();
      const seg = pl.split('\n').find(l => l.startsWith('http'));
      res.playlist_len = pl.length;
      res.seg_url = seg ? seg.slice(0, 200) : null;
      if (seg) {
        const s = await fetch(seg, { headers: { Range: 'bytes=0-1023' } });
        const buf = new Uint8Array(await s.arrayBuffer());
        res.segment = { status: s.status, ct: s.headers.get('content-type'), len: buf.length, first16: [...buf.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('') };
      }
    } catch (e) { res.seg_err = String(e).slice(0, 200); }
  }
  return res;
}, { si, jsToken, streamingUrl480 });

console.log(JSON.stringify(out, null, 2));
await browser.close();
