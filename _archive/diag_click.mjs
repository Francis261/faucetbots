import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ proxy: { server: 'socks5://127.0.0.1:1081' } });
page.on('response', r => {
  if (r.url().includes('challenge-platform')) console.log('[resp]', r.status(), r.url().slice(0, 90));
});
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

for (let i = 0; i < 6; i++) {
  const frames = page.frames();
  console.log(`\n--- iteration ${i + 1}: ${frames.length} frames ---`);
  for (const f of frames) {
    console.log('  frame:', f.url().slice(0, 110));
    if (f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile')) {
      const boxes = await f.locator('[role="checkbox"], input[type="checkbox"], .ctp-checkbox-label, label').count().catch(() => 0);
      console.log('    potential checkbox elements:', boxes);
      if (boxes > 0) {
        const cb = f.locator('[role="checkbox"], input[type="checkbox"], label').first();
        console.log('    clicking...');
        await cb.click().then(() => console.log('    clicked OK')).catch(e => console.log('    click err:', e.message.slice(0, 80)));
      }
    }
  }
  const title = await page.title();
  console.log('  page title:', title);
  if (!title.includes('Just a moment')) break;
  await page.waitForTimeout(5000);
}
await browser.close();
