// probe16.mjs — (a) timed ranged GETs, (b) UI download event -> saveAs
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
console.log('dlink ok');

// (a) ranged chunk timing: 1MB then 8MB
for (const [label, range] of [['1MB', 'bytes=0-1048575'], ['8MB', 'bytes=0-8388607']]) {
  const t0 = Date.now();
  try {
    const r = await ctx.request.get(dlink, {
      headers: { 'user-agent': UA, referer: SHARE, range }, timeout: 60000,
    });
    const buf = await r.body();
    console.log(`range ${label}: ${r.status()} ${buf.length} bytes in ${Date.now() - t0}ms`);
  } catch (e) { console.log(`range ${label}: ERR ${e.message.split('\n')[0].slice(0, 120)} (${Date.now() - t0}ms)`); }
}

// (b) UI download event -> saveAs
const dlPromise = page.waitForEvent('download', { timeout: 30000 });
await page.locator('button:has-text("Download")').first().click({ timeout: 8000 }).catch(e => console.log('click:', e.message.slice(0,80)));
const t0 = Date.now();
try {
  const dl = await dlPromise;
  const target = `/tmp/opencode/ui-dl-${Date.now()}.mp4`;
  await dl.saveAs(target);
  const { statSync } = await import('node:fs');
  console.log(`UI download: ${dl.suggestedFilename()} -> ${target} (${statSync(target).size} bytes) in ${Date.now() - t0}ms`);
} catch (e) { console.log('UI download ERR:', e.message.split('\n')[0].slice(0, 150)); }
await browser.close();
