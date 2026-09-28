// probe15.mjs — why is dlink 403 outside the browser? test header combos
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  storageState: new URL('./cookies.json', import.meta.url).pathname,
});
const page = await ctx.newPage();
let si = null;
page.on('response', async (res) => {
  if (res.url().includes('/api/shorturlinfo')) {
    try { const j = await res.json(); if (j.errno === 0 && j.sign) si = { sign: j.sign, timestamp: j.timestamp, shareid: j.shareid, uk: j.uk }; } catch {}
  }
});
await page.goto('https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(8000);

const dlink = await page.evaluate(async ({ si }) => {
  const bdstoken = window.templateData?.bdstoken || '';
  const jt = window.jsToken || '';
  const pcftoken = document.cookie.match(/pcftoken=([^;]+)/)?.[1] || '';
  const q = new URLSearchParams({
    clientfrom: 'h5', psign: '0', pcftoken, clienttype: '0', channel: 'dubox',
    scene: 'purchased_list', shareid: String(si.shareid), sign: si.sign,
    timestamp: String(si.timestamp), bdstoken,
    app_id: '250528', web: '1', jsToken: jt, 'dp-logid': '',
  });
  const r = await fetch(`/share/download?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({
      product: 'share', nozip: '0',
      fid_list: JSON.stringify(['558462010993370']),
      uk: String(si.uk), primaryid: String(si.shareid),
    }).toString(),
  });
  const j = await r.json();
  return j.dlink || null;
}, { si });

if (!dlink) { console.log('no dlink'); process.exit(1); }
console.log('dlink OK:', dlink.slice(0, 120), '…');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const SHARE = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';

// (i) Playwright API request sharing context cookies
try {
  const r = await ctx.request.get(dlink, { headers: { "user-agent": UA, referer: SHARE, range: "bytes=0-2047" }, timeout: 25000 });
  const body = await r.body();
  console.log(`ctx.request: ${r.status()} ${r.headers()['content-type']} bytes=${body.length} head=${body.subarray(0,4).toString('hex')}`);
} catch (e) { console.log('ctx.request ERR', e.message.slice(0, 150)); }

// (ii) node fetch with explicit cookie header from context
const cookies = await ctx.cookies('https://www.1024tera.com');
const cookieHdr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
for (const [name, headers] of [
  ['cookie+referer', { 'user-agent': UA, referer: SHARE, cookie: cookieHdr, range: 'bytes=0-2047' }],
  ['cookie only', { 'user-agent': UA, cookie: cookieHdr, range: 'bytes=0-2047' }],
  ['referer only', { 'user-agent': UA, referer: SHARE, range: 'bytes=0-2047' }],
  ['bare', { 'user-agent': UA, range: 'bytes=0-2047' }],
]) {
  try {
    const r = await fetch(dlink, { headers, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    console.log(`${name}: ${r.status} ${r.headers.get('content-type')} bytes=${buf.length} head=${buf.subarray(0,4).toString('hex')} ${r.ok ? '' : buf.subarray(0,200).toString()}`);
  } catch (e) { console.log(`${name}: ERR ${e.message.slice(0,120)}`); }
}
await browser.close();
