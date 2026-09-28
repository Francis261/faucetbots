// login.mjs — log in to1024tera.com with the saved account and persist the
// session (Playwright storageState) for terabot.mjs --cookies.
//
//   node login.mjs            (headless)
//   HEADFUL=1 node login.mjs  (real window on DISPLAY=:0 if a captcha appears)
//
// Credentials come from ./.account.json (gitignored): {email, password}
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_STATE = path.join(__dirname, 'cookies.json');
const SHOTS = path.join(__dirname, 'probe-out');
mkdirSync(SHOTS, { recursive: true });

const { email, password } = JSON.parse(
  readFileSync(path.join(__dirname, '.account.json'), 'utf8'),
);
const headful = !!process.env.HEADFUL;

const browser = await chromium.launch({ headless: !headful });
try {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  const loginAttempts = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/passport/login') || u.includes('/api/check/login')) {
      let body = '';
      try { body = (await res.text()).slice(0, 500); } catch {}
      loginAttempts.push({ url: u.slice(0, 160), status: res.status(), body });
      console.error(`[login] ${u.match(/\/passport\/login|\/api\/check\/login/)[0]} -> ${body}`);
    }
    if (u.includes('/passport/prelogin')) {
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch {}
      console.error(`[login] prelogin -> ${body}`);
    }
  });

  console.error('[login] opening /login…');
  await page.goto('https://www.1024tera.com/login', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForTimeout(3000);

  const emailSel = 'input[placeholder*="email" i]';
  const pwdSel = 'input[type="password"]';
  await page.waitForSelector(emailSel, { timeout: 15000 });
  await page.fill(emailSel, email);
  await page.fill(pwdSel, password);

  // diagnostics: what else is on the page (terms checkbox? captcha?)
  const diag = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return {
      inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({
        type: i.type, ph: i.placeholder, checked: i.checked,
      })),
      buttons: [...document.querySelectorAll('button')].filter(vis)
        .map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 15),
      iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 120)),
      text: (document.body.innerText || '').slice(0, 500),
    };
  });
  console.error('[login] page diag:', JSON.stringify(diag, null, 1));

  // tick any visible terms/consent checkbox before submitting
  const boxes = page.locator('input[type="checkbox"]:visible');
  for (let i = 0; i < await boxes.count(); i++) {
    await boxes.nth(i).check({ timeout: 2000 }).catch(() => {});
  }

  const loggedIn = async () => {
    if (loginAttempts.some((a) => a.url.includes('/passport/login') && a.body.includes('"errno":0')))
      return true;
    try {
      const j = await page.evaluate(async () => {
        const r = await fetch('/api/check/login?app_id=250528&web=1&channel=dubox&clienttype=0');
        return r.json();
      });
      return j && j.errno === 0 && (j.login === undefined || j.login === 1 || j.is_login === 1 || j.uk);
    } catch { return false; }
  };

  // submit: click the primary button, fall back to Enter
  const submit = page.locator('button:visible').filter({ hasText: /log ?in|sign ?in|continue/i }).first();
  if (await submit.count()) await submit.click({ timeout: 5000 }).catch(() => {});
  else await page.keyboard.press('Enter');
  console.error('[login] submitted, waiting…');

  const ok = await (async () => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (await loggedIn()) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  })();

  await page.screenshot({ path: path.join(SHOTS, ok ? 'login-ok.png' : 'login-fail.png'), fullPage: true }).catch(() => {});

  if (!ok) {
    const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 600)).catch(() => '');
    console.error('[login] FAILED. page text:\n' + text);
    console.error('[login] passport/login attempts:', JSON.stringify(loginAttempts, null, 1));
    process.exitCode = 1;
  } else {
    await ctx.storageState({ path: OUT_STATE });
    console.error(`[login] SUCCESS — session saved to ${OUT_STATE}`);
  }
} finally {
  await browser.close().catch(() => {});
}
