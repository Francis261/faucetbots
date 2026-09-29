// probe23.mjs — isolate WHERE the "need verify" gate binds:
//   (A) Node fetch list, params from a Node-fetched HTML        [known fail]
//   (B) Node fetch list, params (jsToken/pcftoken) from a BROWSER-fetched HTML
// If B passes -> tokens are bound to the HTML fetch's fingerprint.
// If B fails  -> gate is elsewhere (TLS fingerprint / cookies / headers).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const SHARE = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const surl = 'reCn7CaS8tLmcdVMe3SYWg';

const st = JSON.parse(readFileSync(path.join(__dirname, 'cookies.json'), 'utf8'));
const cookieHeader = st.cookies
  .filter((c) => /1024tera\.com$/.test(c.domain.replace(/^\./, '')))
  .map((c) => `${c.name}=${c.value}`).join('; ');

const H = {
  'user-agent': UA, cookie: cookieHeader, referer: SHARE,
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/x-www-form-urlencoded',
  'x-requested-with': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
};
const dpSession = String(Math.floor((9 * Math.random() + 1) * 1e5));
const dpUser = '00' + Math.floor((9 * Math.random() + 1) * 1e7);
let dpCount = 0;
const nextDpLogid = () => {
  dpCount = dpCount < 9999 ? dpCount + 1 : 0;
  return dpSession + dpUser + String(dpCount).padStart(4, '0');
};

async function tryList(label, { jsToken, pcftoken, nocookie }) {
  const q = new URLSearchParams({
    clientfrom: 'h5', psign: '0', pcftoken, clienttype: '0', channel: 'dubox',
    page: '1', num: '20', web: '1', scene: '', shorturl: surl, root: '1',
    by: 'time', order: 'desc', app_id: '250528', jsToken, 'dp-logid': nextDpLogid(),
  });
  const headers = nocookie
    ? Object.fromEntries(Object.entries(H).filter(([k]) => k !== 'cookie')) : H;
  const r = await fetch(`https://www.1024tera.com/share/list?${q}`, { headers });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch {}
  console.log(`[list ${label}] errno=${j.errno ?? j.code} files=${j.list?.length ?? 0} :: ${txt.slice(0, 120)}`);
  return j;
}

// (A) Node-fetched HTML params
{
  const r = await fetch(SHARE, { headers: { 'user-agent': UA, referer: SHARE } });
  const html = await r.text();
  const jt = (decodeURIComponent((html.match(/eval\(decodeURIComponent\(`([^`]+)`\)\)/) || [])[1] || '').match(/fn\("([0-9A-F]+)"\)/) || [])[1] || '';
  const td = JSON.parse((html.match(/var templateData = (\{.*?\});<\/script>/s) || html.match(/var templateData = (\{.*?\});/s) || [])[1] || '{}');
  await tryList('A node-html', { jsToken: jt, pcftoken: td.pcftoken || '' });
}

// (B) Browser-fetched HTML params (intercept the main document body)
{
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, storageState: path.join(__dirname, 'cookies.json') });
    const page = await ctx.newPage();
    const htmlP = page.waitForResponse((res) => res.url().includes('/sharing/link?'));
    await page.goto(SHARE, { waitUntil: 'commit', timeout: 45000 });
    const res = await htmlP;
    const html = await res.text();
    const jt = (decodeURIComponent((html.match(/eval\(decodeURIComponent\(`([^`]+)`\)\)/) || [])[1] || '').match(/fn\("([0-9A-F]+)"\)/) || [])[1] || '';
    const td = JSON.parse((html.match(/var templateData = (\{.*?\});<\/script>/s) || html.match(/var templateData = (\{.*?\});/s) || [])[1] || '{}');
    console.log(`[browser html] jsToken=${jt.slice(0, 16)}… pcftoken=${td.pcftoken}`);
    await tryList('B browser-html', { jsToken: jt, pcftoken: td.pcftoken || '' });
    // (C) same tokens but WITHOUT cookie header
    await tryList('B browser-html nocookie', { jsToken: jt, pcftoken: td.pcftoken || '', nocookie: true });
  } finally {
    await browser.close().catch(() => {});
  }
}
