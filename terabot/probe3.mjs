// probe3.mjs — (1) play the video and capture the real preview stream URLs
// (m3u8/mp4/segments), (2) test /share/download and /share/streaming from
// inside the page context with the share's own sign/timestamp.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_ = process.argv[2]
  || 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const OUT = new URL('./probe-out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();

const events = [];
let shareInfo = null;

// capture shorturlinfo for share sign/timestamp/shareid/uk
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/shorturlinfo')) {
    try {
      const j = await res.json();
      if (j.errno === 0 && j.sign) {
        shareInfo = { sign: j.sign, timestamp: j.timestamp, shareid: j.shareid, uk: j.uk, randsk: j.randsk };
        events.push(`shareInfo captured: ${JSON.stringify(shareInfo)}`);
      }
    } catch {}
  }
  // media / playlist traffic
  const ct = res.headers()['content-type'] || '';
  const isMedia = /mpegURL|mp2t|video\/|octet-stream/.test(ct)
    || /\.(m3u8|mp4|ts)(\?|$)/i.test(u)
    || u.includes('/share/streaming');
  if (isMedia) {
    const body = /mpegURL|m3u8/.test(ct) || /\.m3u8/i.test(u)
      ? await res.text().catch(() => '') : '';
    events.push(`MEDIA ${res.status()} ${ct} ${u.slice(0, 500)}${body ? `\n  BODY: ${body.slice(0, 1500)}` : ''}`);
  }
});
page.on('request', (req) => {
  const u = req.url();
  if (/\.(m3u8|mp4|ts)(\?|$)|streaming|\/play\//i.test(u))
    events.push(`REQ ${req.method()} ${u.slice(0, 400)}`);
});

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(8000);

// --- (1) play the video ---
events.push('--- clicking video play ---');
await page.locator('video').first().click({ timeout: 5000 }).catch(async () => {
  await page.locator('text=Play').first().click({ timeout: 5000 }).catch(e => events.push('play click fail: ' + e.message.slice(0, 100)));
});
await page.waitForTimeout(12000);

const videoState = await page.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { src: v.currentSrc || v.src, readyState: v.readyState, error: v.error && v.error.code, w: v.videoWidth, h: v.videoHeight, t: v.currentTime } : null;
}).catch(() => null);
events.push(`video state: ${JSON.stringify(videoState)}`);

// --- (2) in-page API tests ---
const apiResults = await page.evaluate(async (si) => {
  const out = {};
  const tryFetch = async (name, url, opts) => {
    try {
      const r = await fetch(url, opts);
      const t = await r.text();
      out[name] = { status: r.status, body: t.slice(0, 1200) };
    } catch (e) { out[name] = { err: String(e).slice(0, 200) }; }
  };
  if (!si) return { err: 'no shareInfo' };
  const q = new URLSearchParams({
    uk: String(si.uk), shareid: String(si.shareid), sign: si.sign,
    timestamp: String(si.timestamp), app_id: '250528', clienttype: '0',
    web: '1', channel: 'dubox',
  });
  // download attempts — query + body variants
  const dlQ = new URLSearchParams(q); dlQ.set('scene', ''); dlQ.set('bdstoken', '');
  await tryFetch('download_GET', `/share/download?${dlQ}&fid_list=${JSON.stringify(['558462010993370'])}&type=dlink&primaryid=${si.shareid}&need_speed=0&nozip=0`);
  await tryFetch('download_POST', `/share/download?scene=&bdstoken=&product=share`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({
      uk: String(si.uk), shareid: String(si.shareid), sign: si.sign,
      timestamp: String(si.timestamp), app_id: '250528', clienttype: '0',
      fid_list: JSON.stringify(['558462010993370']), type: 'dlink',
      primaryid: String(si.shareid), need_speed: '0', nozip: '0',
    }).toString(),
  });
  // streaming type guesses
  for (const ty of ['m3u8', 'mp4', '0', '1']) {
    const s = new URLSearchParams(q); s.set('type', ty); s.set('fid', '558462010993370');
    s.set('esl', '1'); s.set('isplayer', '1'); s.set('ehps', '1');
    await tryFetch(`stream_${ty}`, `/share/streaming?${s}`);
  }
  return out;
}, shareInfo);

writeFileSync(`${OUT}/api-tests.json`, JSON.stringify({ shareInfo, apiResults, videoState }, null, 2));
console.log(events.join('\n'));
console.log('=== API TESTS ===');
for (const [k, v] of Object.entries(apiResults || {})) console.log(k, '=>', JSON.stringify(v).slice(0, 700), '\n');
await browser.close();
