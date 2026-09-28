// probe13.mjs — does a login page route exist? try a few URLs
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36', viewport: { width: 1280, height: 800 } });
for (const u of ['https://www.1024tera.com/login', 'https://www.1024tera.com/?login=true', 'https://www.1024tera.com/']) {
  const page = await ctx.newPage();
  try {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    const r = await page.evaluate(() => ({
      inputs: [...document.querySelectorAll('input')].map(i => ({
        type: i.type, name: i.name, id: i.id, ph: i.placeholder,
        vis: !!(i.offsetWidth || i.offsetHeight),
      })),
      text: (document.body.innerText || '').slice(0, 400),
      url: location.href,
    }));
    console.log(`\n=== ${u} -> ${r.url}`);
    console.log('inputs:', JSON.stringify(r.inputs));
    console.log('text:', r.text.replace(/\n/g, ' | ').slice(0, 300));
  } catch (e) { console.log(u, 'ERR', e.message.slice(0, 100)); }
  await page.close();
}
await browser.close();
