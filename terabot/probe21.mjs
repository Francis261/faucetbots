// probe21.mjs — capture FULL request URLs + headers the app sends
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
  const seen = new Set();
  page.on('request', (req) => {
    const u = req.url();
    if (/\/share\/list\?|querysurltransfer|\/api\/shorturlinfo|\/share\/mediameta|\/share\/download\?|\/api\/check\/login/.test(u)) {
      const key = u.split('?')[0] + '|' + (req.method());
      if (seen.has(key)) return;
      seen.add(key);
      console.log(`\n=== ${req.method()} ${u}`);
      const h = req.headers();
      for (const k of ['cookie', 'referer', 'origin', 'content-type', 'x-csrf-token', 'csrf-token'])
        if (h[k]) console.log(`  ${k}: ${String(h[k]).slice(0, 400)}`);
      if (req.postData()) console.log(`  body: ${req.postData().slice(0, 400)}`);
    }
  });
  await page.goto(SHARE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(15000);
  const cookies = await ctx.cookies();
  console.log('\n=== cookies on 1024tera.com:');
  for (const c of cookies) console.log(`  ${c.name} = ${String(c.value).slice(0, 30)}… (${c.domain})`);
} finally {
  await browser.close().catch(() => {});
}
