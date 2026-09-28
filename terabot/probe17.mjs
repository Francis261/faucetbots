// probe17.mjs — get a fresh dlink, then curl diagnostics (range speed, redirects)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
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
await browser.close();
if (!dlink) { console.log('no dlink'); process.exit(1); }
console.log('dlink:', dlink.slice(0, 140), '…');

const curl = (args, label) => {
  try {
    const out = execFileSync('curl', ['-sS', '-L', '-A', UA, '-e', SHARE, ...args], {
      encoding: 'utf8', timeout: 70000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`--- ${label}:\n${out.slice(0, 700)}`);
  } catch (e) {
    console.log(`--- ${label}: ERR ${String(e.stdout || e.message).slice(0, 700)}`);
  }
};
// redirect chain + headers (no body)
curl(['-D', '-', '-o', '/dev/null', '-r', '0-1023', '--max-time', '25', dlink], 'range 1KB headers');
// speed tests
for (const [label, r] of [['64KB', '0-65535'], ['1MB', '0-1048575']]) {
  curl(['-o', '/dev/null', '-r', r, '--max-time', '30',
    '-w', `code=%{http_code} time=%{time_total} speed=%{speed_download}B/s size=%{size_download} redirects=%{num_redirects} final=%{url_effective}\n`,
    dlink], `range ${label}`);
}
// full download speed (30s cap)
curl(['-o', '/dev/null', '--max-time', '30',
  '-w', `code=%{http_code} time=%{time_total} speed=%{speed_download}B/s size=%{size_download}\n`,
  dlink], 'full 30s');
