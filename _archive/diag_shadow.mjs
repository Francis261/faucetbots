import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--host-resolver-rules=MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41',
  ],
});
const context = await browser.newContext({});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
for (const f of page.frames()) {
  if (/challenges\.cloudflare\.com|turnstile/i.test(f.url())) {
    const info = await f.evaluate(() => {
      function walk(root, depth) {
        const out = [];
        const all = root.querySelectorAll('*');
        for (const el of all) {
          const sr = el.shadowRoot;
          if (sr) {
            out.push({ tag: el.tagName, id: el.id, cls: el.className?.slice?.(0, 60), children: sr.childElementCount });
            out.push(...walk(sr, depth + 1));
          }
        }
        return out;
      }
      return walk(document, 0);
    });
    console.log('shadow roots:', JSON.stringify(info, null, 1).slice(0, 4000));
  }
}
await browser.close();
