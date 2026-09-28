// probe6.mjs — definitive param tests:
//  (a) streaming qualities with the real HMAC-SHA1 sign formula
//  (b) /share/download with the exact frontend param merge (incl. dp-logid, psign, clientfrom)
import { chromium } from 'playwright';

const URL_ = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36' });
const page = await ctx.newPage();

let jsToken = null, dpLogid = null, si = null;
page.on('request', (req) => {
  const u = req.url();
  const m = u.match(/jsToken=([A-F0-9]+)/); if (m && !jsToken) jsToken = m[1];
  const d = u.match(/dp-logid=(\d+)/); if (d && !dpLogid) dpLogid = d[1];
});
page.on('response', async (res) => {
  if (res.url().includes('/api/shorturlinfo')) {
    try { const j = await res.json(); if (j.errno === 0 && j.sign) si = { sign: j.sign, timestamp: j.timestamp, shareid: j.shareid, uk: j.uk }; } catch {}
  }
});

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(7000);

const out = await page.evaluate(async ({ si, jsToken, dpLogid }) => {
  const res = { notes: [] };
  const browserid = document.cookie.match(/browserid=([^;]+)/)?.[1] || '';
  res.browserid = browserid;
  res.templateData = window.templateData ? Object.keys(window.templateData) : null;
  res.bdstoken = window.templateData?.bdstoken ?? null;

  // HMAC-SHA1 hex like CryptoJS HmacSHA1(msg, key).toString()
  const hmacSha1 = async (msg, key) => {
    const enc = new TextEncoder();
    const ck = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(msg));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const base = { clienttype: '0', app_id: '250528', web: '1', channel: 'dubox', jsToken: jsToken || '' };

  // (a) streaming qualities with real sign
  const types = ['M3U8_FLV_264_360', 'M3U8_FLV_264_480', 'M3U8_AUTO_720', 'M3U8_AUTO_1080', 'M3U8_AUTO_4K'];
  res.stream = {};
  for (const ty of types) {
    const ts = Math.floor(Date.now() / 1000);
    const sign = await hmacSha1(`0dubox${browserid}${ts}`, 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa');
    const q = new URLSearchParams({ ...base, uk: String(si.uk), shareid: String(si.shareid), type: ty, fid: '558462010993370', sign, timestamp: String(ts), esl: '1', isplayer: '1', ehps: '1' });
    try {
      const r = await fetch(`/share/streaming?${q}`);
      const t = await r.text();
      res.stream[ty] = { status: r.status, ct: r.headers.get('content-type'), head: t.slice(0, 240) };
    } catch (e) { res.stream[ty] = { err: String(e).slice(0, 120) }; }
  }

  // (b) download with exact frontend param merge
  const q = new URLSearchParams({
    clientfrom: 'h5', psign: '0',
    pcftoken: document.cookie.match(/pcftoken=([^;]+)/)?.[1] || '',
    clienttype: '0', channel: 'dubox',
    app_id: '250528', web: '1', jsToken: jsToken || '',
    'dp-logid': dpLogid || '',
    scene: '', bdstoken: String(res.bdstoken ?? ''),
    shareid: String(si.shareid), type: 'dlink', sign: si.sign, timestamp: String(si.timestamp), need_speed: '0',
  });
  try {
    const r = await fetch(`/share/download?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({
        product: 'share', uk: String(si.uk),
        fid_list: JSON.stringify(['558462010993370']),
        primaryid: String(si.shareid),
      }).toString(),
    });
    res.download = { status: r.status, body: (await r.text()).slice(0, 900) };
  } catch (e) { res.download = { err: String(e).slice(0, 150) }; }
  return res;
}, { si, jsToken, dpLogid });

console.log(JSON.stringify(out, null, 2));
await browser.close();
