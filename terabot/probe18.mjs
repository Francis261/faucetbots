// probe18.mjs — account tier + ranged throughput map with fresh dlinks
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

const tier = await page.evaluate(() => ({
  userVipIdentity: window.templateData?.userVipIdentity,
  text: ([...document.querySelectorAll('*')]
    .filter(e => e.children.length === 0 && /premium|vip|upgrade/i.test(e.textContent || ''))
    .map(e => e.textContent.trim()).slice(0, 5)),
}));
console.log('TIER:', JSON.stringify(tier));

const getDlink = () => page.evaluate(async ({ si }) => {
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

for (const [label, range, to] of [
  ['64KB fresh dlink', 'bytes=0-65535', 30000],
  ['1MB fresh dlink', 'bytes=0-1048575', 45000],
  ['10MB fresh dlink', 'bytes=0-10485759', 60000],
]) {
  const d = await getDlink();
  if (!d) { console.log(label, ': no dlink'); continue; }
  const t0 = Date.now();
  try {
    const r = await ctx.request.get(d, {
      headers: { 'user-agent': UA, referer: SHARE, range }, timeout: to,
    });
    const buf = await r.body();
    const ms = Date.now() - t0;
    console.log(`${label}: ${r.status()} ${buf.length}B in ${ms}ms (${Math.round(buf.length / (ms / 1000) / 1024)}KB/s)`);
  } catch (e) {
    console.log(`${label}: ERR ${e.message.split('\n')[0].slice(0, 100)} (${Date.now() - t0}ms)`);
  }
}
await browser.close();
