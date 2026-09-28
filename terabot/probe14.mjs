// probe14.mjs — logged-in: click Download, capture the real flow
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = new URL('./probe-out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  storageState: new URL('./cookies.json', import.meta.url).pathname,
});
const page = await ctx.newPage();
const events = [];
const t0 = Date.now();
page.on('request', (req) => {
  const u = req.url();
  if (/download|taskquery|invoker|transfer|verify|pset|check\/login/i.test(u) && !/\.(js|css|png|jpg)/.test(u))
    events.push(`[${((Date.now()-t0)/1000).toFixed(1)}s] REQ ${req.method()} ${u.slice(0, 280)}`);
});
page.on('response', async (res) => {
  const u = res.url();
  const loc = res.headers()['location'];
  if (loc) events.push(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${res.status()} REDIRECT ${u.slice(0,120)} -> ${loc.slice(0, 300)}`);
  if (/download|taskquery|invoker|transfer|check\/login|shorturlinfo/i.test(u) && !/\.(js|css|png|jpg)/.test(u)) {
    let body = '';
    try {
      const ct = res.headers()['content-type'] || '';
      if (/json|text/.test(ct)) body = (await res.text()).slice(0, 700);
    } catch {}
    events.push(`[${((Date.now()-t0)/1000).toFixed(1)}s] RESP ${res.status()} ${u.slice(0, 240)}${body ? ` :: ${body}` : ''}`);
  }
});
page.on('download', d => events.push(`BROWSER DOWNLOAD: ${d.suggestedFilename()} url=${d.url().slice(0,300)}`));
page.on('framenavigated', f => { if (f === page.mainFrame()) events.push(`NAV ${f.url().slice(0,200)}`); });

await page.goto('https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto', e.message));
await page.waitForTimeout(8000);

// who am I + templateData
const env = await page.evaluate(() => ({
  checkText: document.body.innerText.slice(0, 300),
  bdstoken: window.templateData?.bdstoken ?? null,
  hasLoginBtn: !!([...document.querySelectorAll('button,a')].find(b => /login|log in/i.test(b.innerText || ''))),
}));
events.push('ENV ' + JSON.stringify(env));

const dl = page.locator('button:has-text("Download")').first();
events.push('Download visible: ' + await dl.isVisible().catch(()=>false));
await dl.click({ timeout: 8000 }).catch(e => events.push('click fail ' + e.message.slice(0,100)));
await page.waitForTimeout(15000);

const after = await page.evaluate(() => (document.body.innerText || '').slice(0, 500));
writeFileSync(`${OUT}/probe14-after.txt`, after);
console.log(events.join('\n'));
console.log('--- after text:', after.replace(/\n/g, ' | ').slice(0, 400));
await browser.close();
