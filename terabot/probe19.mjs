// probe19.mjs — parallel range throughput test (per-connection vs per-account cap)
import { chromium } from 'playwright';
const SHARE = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: UA, viewport: { width: 1280, height: 800 },
  storageState: new URL('./cookies.json', import.meta.url).pathname,
});
const page = await ctx.newPage();
let si = null;
page.on('response', async (res) => {
  if (res.url().includes('/api/shorturlinfo')) {
    try { const j = await res.json(); if (j.errno === 0 && j.sign) si = { sign: j.sign, timestamp: j.timestamp, shareid: j.shareid, uk: j.uk }; } catch {}
  }
});
await page.goto(SHARE, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(8000);

const dlink = await page.evaluate(async ({ si }) => {
  const q = new URLSearchParams({
    clientfrom: 'h5', psign: '0',
    pcftoken: document.cookie.match(/pcftoken=([^;]+)/)?.[1] || '',
    clienttype: '0', channel: 'dubox', scene: 'purchased_list',
    shareid: String(si.shareid), sign: si.sign, timestamp: String(si.timestamp),
    bdstoken: window.templateData?.bdstoken || '',
    app_id: '250528', web: '1', jsToken: window.jsToken || '', 'dp-logid': '',
  });
  const r = await fetch(`/share/download?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({
      product: 'share', nozip: '0', fid_list: JSON.stringify(['558462010993370']),
      uk: String(si.uk), primaryid: String(si.shareid),
    }).toString(),
  });
  const j = await r.json();
  return j.dlink || null;
}, { si });
if (!dlink) { console.log('no dlink'); process.exit(1); }

// 4 parallel 512KB chunks
const CHUNK = 512 * 1024;
const t0 = Date.now();
const results = await Promise.all([0, 1, 2, 3].map(async (i) => {
  const a = i * CHUNK, b = a + CHUNK - 1;
  const t = Date.now();
  try {
    const r = await ctx.request.get(dlink, {
      headers: { 'user-agent': UA, referer: SHARE, range: `bytes=${a}-${b}` },
      timeout: 90000,
    });
    const buf = await r.body();
    return { i, status: r.status(), bytes: buf.length, ms: Date.now() - t };
  } catch (e) { return { i, err: e.message.split('\n')[0].slice(0, 80), ms: Date.now() - t }; }
}));
const totalMs = Date.now() - t0;
const totalBytes = results.reduce((s, r) => s + (r.bytes || 0), 0);
console.log(JSON.stringify(results, null, 1));
console.log(`aggregate: ${totalBytes}B in ${totalMs}ms = ${Math.round(totalBytes / (totalMs / 1000) / 1024)}KB/s`);
await browser.close();
