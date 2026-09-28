// probe4.mjs — retry /share/download with the page's jsToken/pcftoken and
// exact frontend param shape; also probe a couple of type variants for the stream.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL_ = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36' });
const page = await ctx.newPage();

let jsToken = null, shareInfo = null;
page.on('request', (req) => {
  const u = req.url();
  if (!jsToken) { const m = u.match(/jsToken=([A-F0-9]+)/); if (m) jsToken = m[1]; }
});
page.on('response', async (res) => {
  if (res.url().includes('/api/shorturlinfo')) {
    try { const j = await res.json(); if (j.errno === 0 && j.sign) shareInfo = { sign: j.sign, timestamp: j.timestamp, shareid: j.shareid, uk: j.uk }; } catch {}
  }
});

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(8000);

const results = await page.evaluate(async ({ si, jt }) => {
  const out = {};
  const pcftoken = document.cookie.match(/pcftoken=([^;]+)/)?.[1] || '';
  const base = { clienttype: '0', web: '1', channel: 'dubox', app_id: '250528', jsToken: jt || '', pcftoken };
  const tryFetch = async (name, url, opts) => {
    try { const r = await fetch(url, opts); out[name] = { status: r.status, body: (await r.text()).slice(0, 800) }; }
    catch (e) { out[name] = { err: String(e).slice(0, 150) }; }
  };
  // exact getDlink shape: query={shareid,type,sign,timestamp,need_speed} body={uk,fid_list,primaryid}
  const q = new URLSearchParams({ ...base, shareid: String(si.shareid), type: 'dlink', sign: si.sign, timestamp: String(si.timestamp), need_speed: '0' });
  await tryFetch('dlink_q', `/share/download?${q}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ uk: String(si.uk), fid_list: JSON.stringify(['558462010993370']), primaryid: String(si.shareid), product: 'share', nozip: '0', bdstoken: '' }).toString(),
  });
  // scene=purchased_list shape (Wt)
  const q2 = new URLSearchParams({ ...base, scene: 'purchased_list' });
  await tryFetch('purchased', `/share/download?${q2}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ product: 'share', nozip: '0', fid_list: JSON.stringify(['558462010993370']), uk: String(si.uk), shareid: String(si.shareid), sign: si.sign, timestamp: String(si.timestamp), type: 'dlink' }).toString(),
  });
  return out;
}, { si: shareInfo, jt: jsToken });

console.log('jsToken:', jsToken?.slice(0, 40), 'shareInfo:', JSON.stringify(shareInfo));
console.log(JSON.stringify(results, null, 2));
await browser.close();
