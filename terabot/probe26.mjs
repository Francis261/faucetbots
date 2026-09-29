// probe26.mjs — locate the real submit control on /login (custom SPA, no <form>)
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto('https://www.1024tera.com/login', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForTimeout(3500);

  const dom = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const pwd = document.querySelector('input[type="password"]');
    // walk up 4 levels from the password input
    let anc = pwd, chain = [];
    for (let i = 0; i < 5 && anc; i++, anc = anc.parentElement) {
      chain.push(`<${anc.tagName.toLowerCase()} class="${(anc.className || '').toString().slice(0, 60)}">`);
    }
    // every element whose exact own text is Login / Sign in / Log in
    const exact = [];
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (/^(Login|Log in|Sign in)$/i.test(t) && vis(el)) {
        exact.push({
          tag: el.tagName, cls: (el.className || '').toString().slice(0, 70),
          kids: el.children.length, clickable: !!(el.onclick || el.getAttribute('role')),
        });
        if (exact.length > 8) break;
      }
    }
    // password input parent html (the card around the fields)
    const card = pwd && pwd.parentElement && pwd.parentElement.parentElement;
    return {
      pwdChain: chain,
      pwdParentHtml: pwd && pwd.parentElement ? pwd.parentElement.outerHTML.slice(0, 900) : null,
      cardHtml: card ? card.outerHTML.slice(0, 2500) : null,
      exact,
    };
  });
  console.log(JSON.stringify(dom, null, 1));

  // try clicking via text locator and watch requests
  const posts = [];
  page.on('request', (req) => {
    if (/passport/.test(req.url()))
      posts.push(`${req.method()} ${req.url().slice(0, 120)}`);
  });
  await page.fill('input[placeholder*="email" i]', 'metalio031@gmail.com');
  await page.fill('input[type="password"]', 'Frank986532#');
  const loc = page.locator('text=/^(Login|Sign in)$/i').first();
  let clicked = 'none';
  if (await loc.count()) {
    await loc.click({ timeout: 4000 }).then(() => { clicked = 'text-locator'; }).catch((e) => { clicked = 'click-fail: ' + e.message.slice(0, 80); });
  } else {
    // last resort: Enter key from the password field
    await page.locator('input[type="password"]').press('Enter');
    clicked = 'enter';
  }
  console.log('clicked:', clicked);
  await page.waitForTimeout(6000);
  console.log('passport requests:', JSON.stringify(posts, null, 1));
  const st = await page.evaluate(async () => {
    const j = await (await fetch('/api/check/login?app_id=250528&web=1&channel=dubox&clienttype=0')).json();
    return j;
  });
  console.log('check/login now:', JSON.stringify(st).slice(0, 200));
  await page.screenshot({ path: 'probe-out/login-probe26.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
}
