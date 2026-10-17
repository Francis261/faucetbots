// Diagnose the /withdraw Turnstile widget:
//  - dump console errors + failed CF requests
//  - dump every iframe / turnstile container on the page
//  - test-render a fresh widget with the site's own sitekey
// Runs against a COPY of the bot profile (never the live one).
import { chromium } from 'playwright';

const SITE = 'https://moonptc.com';
const PROFILE = process.env.PROBE_PROFILE || '/tmp/moonptc-probe-profile';

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = context.pages()[0] || await context.newPage();

page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /turnstile|cloudflare/i.test(t)) {
    console.log(`CONSOLE ${m.type()}: ${t.slice(0, 250)}`);
  }
});
page.on('requestfailed', (r) => {
  if (/cloudflare|turnstile/i.test(r.url())) {
    console.log(`REQFAIL: ${r.url().slice(0, 110)} :: ${r.failure()?.errorText}`);
  }
});
page.on('response', (r) => {
  if (/challenges\.cloudflare/i.test(r.url())) {
    console.log(`CF RESP: ${r.status()} ${r.url().slice(0, 110)}`);
  }
});

await page.goto(SITE + '/withdraw', { waitUntil: 'commit', timeout: 45000 });
await new Promise((r) => setTimeout(r, 9000));

const diag = await page.evaluate(async () => {
  const info = await fetch('/api/withdraw/info', { credentials: 'include' })
    .then((r) => r.json()).catch(() => null);
  return {
    url: location.pathname,
    loggedIn: /withdraw/.test(location.pathname),
    turnstileAPI: typeof window.turnstile,
    sitekey: window.__TURNSTILE_SITEKEY__ || null,
    enabledFlag: window.__TURNSTILE_ENABLED__,
    cryptos: info?.cryptos?.map((c) => `${c.symbol}:${c.name}`) || null,
    minAmount: info?.minAmount,
    cooldownRemaining: info?.cooldownRemaining,
    hasResponseInput: !!document.querySelector('input[name="cf-turnstile-response"]'),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({
      src: (f.src || '(none)').slice(0, 90),
      srcdoc: (f.srcdoc || '').slice(0, 40),
      w: f.clientWidth, h: f.clientHeight,
      parent: String(f.parentElement?.className || '').slice(0, 70),
    })),
    widgetContainers: [...document.querySelectorAll('div')]
      .filter((d) => /turnstile|cf-/.test(String(d.className)) ||
        String(d.id).match(/turnstile|cf-/i) ||
        d.querySelector(':scope > iframe'))
      .slice(0, 8)
      .map((d) => d.outerHTML.slice(0, 260)),
    verifyText: /verify you are human/i.test(document.body.innerText),
  };
});
console.log('DIAG: ' + JSON.stringify(diag, null, 1));

// fresh render test with the site's own sitekey — if this yields a token we
// can bypass the site's broken widget entirely
const renderTest = await page.evaluate(() => new Promise((resolve) => {
  if (typeof window.turnstile !== 'object' || !window.turnstile.render) {
    return resolve({ ok: false, reason: 'no turnstile api' });
  }
  const div = document.createElement('div');
  div.id = 'probe-widget';
  div.style.cssText = 'position:fixed;left:10px;top:10px;z-index:999999;';
  document.body.appendChild(div);
  const done = (o) => resolve(o);
  const timer = setTimeout(() => done({ ok: false, reason: 'no token in 35s (may need checkbox click)' }), 35000);
  try {
    window.turnstile.render(div, {
      sitekey: window.__TURNSTILE_SITEKEY__,
      theme: 'dark',
      callback: (tok) => { clearTimeout(timer); done({ ok: true, token: tok.slice(0, 24) }); },
      'error-callback': (e) => { clearTimeout(timer); done({ ok: false, reason: 'error-callback', detail: String(e) }); },
    });
  } catch (e) { clearTimeout(timer); done({ ok: false, reason: 'render threw: ' + String(e) }); }
}));
console.log('RENDER TEST: ' + JSON.stringify(renderTest));

// did OUR widget render a checkbox? if so, click it and wait for a token
if (!renderTest.ok) {
  const box = await page.evaluate(() => {
    const w = document.querySelector('#probe-widget iframe');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, src: (w.src || '').slice(0, 60) };
  }).catch(() => null);
  console.log('PROBE WIDGET BOX: ' + JSON.stringify(box));
  if (box && box.w > 0) {
    await page.evaluate(() => {
      document.querySelectorAll('[data-cc-id]').forEach((d) => { d.style.pointerEvents = 'none'; });
    }).catch(() => {});
    await page.mouse.click(box.x + 25, box.y + box.h / 2);
    const tok = await page.evaluate(() => new Promise((resolve) => {
      const iv = setInterval(() => {
        const v = document.querySelector('input[name="cf-turnstile-response"]')?.value;
        if (v && v.length > 10) { clearInterval(iv); resolve(v.slice(0, 24)); }
      }, 1000);
      setTimeout(() => { clearInterval(iv); resolve(null); }, 25000);
    }));
    console.log('AFTER CLICK TOKEN: ' + JSON.stringify(tok));
  }
}

await page.screenshot({ path: '/tmp/moonptc-shots/probe-withdraw.png' });
await context.close();
console.log('PROBE DONE');
