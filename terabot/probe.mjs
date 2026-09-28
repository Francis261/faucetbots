// probe.mjs — reconnaissance: render the share page, capture the SPA's API
// traffic (file-list JSON), and dump what the DOM exposes (file rows,
// download buttons, media elements, links).
//
//   node probe.mjs [url]
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

const netlog = [];
page.on('response', async (res) => {
  const u = res.url();
  const ct = (res.headers()['content-type'] || '');
  const interesting =
    /share|list|download|preview|play|file|shorturl|surl|node|api/i.test(u)
    && !/\.(png|jpe?g|gif|css|woff2?|svg|webp|ico)(\?|$)/i.test(u);
  if (!interesting) return;
  let body = '';
  if (/json/.test(ct)) body = (await res.text().catch(() => '')).slice(0, 4000);
  netlog.push({ status: res.status(), url: u.slice(0, 300), ct: ct.slice(0, 60), body });
});

console.log(`goto ${URL_}`);
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
  const vids = [...document.querySelectorAll('video,video source')].map(v => v.currentSrc || v.src || '').filter(Boolean);
  const links = [...document.querySelectorAll('a[href]')]
    .map(a => ({ t: (a.innerText || '').trim().slice(0, 60), h: a.getAttribute('href') }))
    .filter(x => x.h && /download|file|play|dlink|sharing/i.test(x.h)).slice(0, 30);
  const btns = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 30);
  const inputs = [...document.querySelectorAll('input')].map(i => ({ id: i.id, name: i.name, val: (i.value || '').slice(0, 80) }));
  return {
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 3000),
    vids, links, btns, inputs,
    html: document.documentElement.outerHTML.length,
  };
});

writeFileSync(`${OUT}/dom.json`, JSON.stringify(info, null, 2));
writeFileSync(`${OUT}/net.json`, JSON.stringify(netlog, null, 2));
await page.screenshot({ path: `${OUT}/page.png`, fullPage: true }).catch(() => {});
await ctx.storageState({ path: `${OUT}/storage-state.json` }).catch(() => {});

console.log('--- title:', info.title);
console.log('--- video srcs:', JSON.stringify(info.vids));
console.log('--- buttons:', JSON.stringify(info.btns));
console.log('--- links:', JSON.stringify(info.links, null, 1));
console.log('--- network hits:', netlog.length);
for (const n of netlog) console.log(`  ${n.status} ${n.ct} ${n.url}${n.body ? ` body=${n.body.slice(0, 200)}` : ''}`);
console.log(`saved -> ${OUT}`);
await browser.close();
