import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
await page.goto('https://adbtc.top/', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(8000);
  console.log(`=== poll ${i + 1} (${(i + 1) * 8}s) ===`);
  const title = await page.title();
  console.log('title:', title);
  if (!title.includes('Just a moment')) { console.log('no challenge, proceeding'); break; }
  const top = page.frames()[0];
  const info = await top.evaluate(() => {
    const b = document.body;
    return {
      text: b ? b.innerText.slice(0, 300) : 'none',
      clickables: b ? [...b.querySelectorAll('button, a, [role="checkbox"], input[type="checkbox"], label, [onclick], [class*="btn"], [class*="turnstile"], [id*="challenge"]')].map(e => ({
        tag: e.tagName, id: e.id, cls: (e.className||'').toString().slice(0, 60), text: (e.innerText||'').trim().slice(0, 40),
      })).slice(0, 30) : [],
      iframes: [...document.querySelectorAll('iframe')].map(f => ({ id: f.id, src: (f.src||'').slice(0, 100), style: f.getAttribute('style') })),
      html: b ? b.innerHTML.slice(0, 800) : 'none',
    };
  }).catch(e => ({ err: e.message.slice(0, 120) }));
  console.log(JSON.stringify(info, null, 1).slice(0, 4000));
}
await browser.close();
