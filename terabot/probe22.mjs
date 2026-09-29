// probe22.mjs — capture the app's /share/list request with ALL headers and
// its response, so a plain-fetch replay can be compared byte for byte.
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const SHARE = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 1280, height: 800 },
    ...(process.argv.includes('--anon') ? {} : { storageState: 'cookies.json' }),
  });
  const page = await ctx.newPage();
  const events = [];
  page.on('request', (req) => {
    if (req.url().includes('/share/list?')) {
      events.push((async () => {
        const h = await req.allHeaders();
        console.log('\n=== LIST REQUEST\n' + req.url());
        console.log(JSON.stringify(h, null, 1));
      })());
    }
  });
  page.on('response', async (res) => {
    if (res.url().includes('/share/list?')) {
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch {}
      console.log(`\n=== LIST RESPONSE status=${res.status()} set-cookie=${res.headers()['set-cookie'] || 'none'}\n${body}`);
    }
    if (res.url().includes('/share/download?')) {
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch {}
      console.log(`\n=== DOWNLOAD RESPONSE status=${res.status()}\n${body}`);
    }
  });
  await page.goto(SHARE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(14000);
  // the Download button's flow: transfer already fired; ask for the dlink
  const dlink = await page.evaluate(async () => {
    const td = window.templateData || {};
    const loc = new URL(location.href);
    const surl = loc.searchParams.get('surl');
    const common = {
      clientfrom: 'h5', psign: '0',
      pcftoken: document.cookie.match(/(?:^|;\s*)pcftoken=([^;]+)/)?.[1] || '',
      clienttype: '0', channel: 'dubox', app_id: '250528', web: '1',
      jsToken: window.jsToken || '', 'dp-logid': window.dpLogid || '',
      bdstoken: td.bdstoken || '',
    };
    const info = await (await fetch(`/api/shorturlinfo?${new URLSearchParams({
      ...common, shorturl: '1' + surl, root: '1', scene: '',
    })}`)).json();
    const si = info;
    const dl = await fetch(`/share/download?${new URLSearchParams({
      ...common, scene: 'purchased_list', shareid: String(si.shareid),
      sign: si.sign || '', timestamp: String(si.timestamp),
    })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({
        product: 'share', nozip: '0',
        fid_list: JSON.stringify(['558462010993370']),
        uk: String(si.uk), primaryid: String(si.shareid),
      }),
    });
    return { si: { errno: si.errno, shareid: si.shareid, uk: si.uk }, d: await dl.text() };
  });
  console.log('\n=== IN-PAGE dlink:', JSON.stringify(dlink).slice(0, 500));
  const cookies = await ctx.cookies();
  console.log('\n=== ctx cookies:');
  for (const c of cookies.filter((c) => c.domain.includes('1024tera')))
    console.log(`  ${c.name}=${c.value.slice(0, 30)}… domain=${c.domain} expires=${c.expires}`);
} finally {
  await browser.close().catch(() => {});
}
