import { chromium } from 'playwright';
const context = await chromium.launchPersistentContext('/tmp/cf-probe', {
  headless: true,
  args: ['--no-sandbox'],
});
const page = await context.pages()[0] || await context.newPage();
await page.goto('https://adbtc.top/index/enter', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const frames = [];
  for (const f of document.querySelectorAll('iframe')) {
    frames.push({ id: f.id, src: f.src ? f.src.slice(0, 120) : null, cls: f.className });
  }
  const checkbox = [...document.querySelectorAll('[role=checkbox], input[type=checkbox], .cf-turnstile, .turnstile-wrapper, [class*=turnstile]')].map(e => ({
    tag: e.tagName, id: e.id, cls: e.className.slice(0, 80),
  }));
  const body = document.body.innerText.trim().slice(0, 300);
  const html = document.documentElement.outerHTML.slice(0, 200);
  return { frames, checkbox, body, html };
});
console.log(JSON.stringify(info, null, 2));
await context.close();
