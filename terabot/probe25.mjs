// probe25.mjs — dump the /login form structure to find the real submit control
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  const posts = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/passport|check\/login/.test(u)) {
      posts.push(`${req.method()} ${u.slice(0, 140)}` +
        (req.postData() ? ` body=${req.postData().slice(0, 200)}` : ''));
    }
  });
  await page.goto('https://www.1024tera.com/login', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForTimeout(3000);

  const dom = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const pwd = document.querySelector('input[type="password"]');
    const form = pwd && pwd.closest('form');
    const controls = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a')]
      .filter(vis)
      .map((b) => ({
        tag: b.tagName, type: b.getAttribute('type') || '',
        text: (b.innerText || b.value || '').trim().slice(0, 40),
        cls: (b.className || '').toString().slice(0, 80),
        inForm: form ? form.contains(b) : false,
      }));
    return {
      hasForm: !!form,
      formHtml: form ? form.outerHTML.slice(0, 1500) : null,
      controls,
      checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].length,
      divLogin: [...document.querySelectorAll('div, span')]
        .filter((d) => vis(d) && /^(log ?in|sign ?in)$/i.test((d.innerText || '').trim()))
        .slice(0, 6)
        .map((d) => ({ tag: d.tagName, cls: (d.className || '').toString().slice(0, 60) })),
    };
  });
  console.log(JSON.stringify(dom, null, 1));

  // fill + try the in-form control; watch what fires
  await page.fill('input[placeholder*="email" i]', 'metalio031@gmail.com');
  await page.fill('input[type="password"]', 'Frank986532#');
  const clickTarget = await page.evaluate(() => {
    const pwd = document.querySelector('input[type="password"]');
    const form = pwd && pwd.closest('form');
    const btn = form && form.querySelector('button, input[type="submit"]');
    if (btn) { btn.click(); return 'form-control: ' + btn.tagName + ' ' + (btn.innerText || btn.value); }
    return null;
  });
  console.log('clicked:', clickTarget);
  await page.waitForTimeout(6000);
  console.log('requests fired:', JSON.stringify(posts, null, 1));
  const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 400));
  console.log('page text after submit:\n' + text);
  await page.screenshot({ path: 'probe-out/login-probe25.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
}
