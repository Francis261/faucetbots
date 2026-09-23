import { chromium } from 'playwright';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE_URL = 'https://onlyfaucet.com';
const FAUCET_URL = `${BASE_URL}/faucet/currency/usdt`;
const PROFILE = join(process.env.HOME, '.onlyfaucet-chrome-profile');
const EMAIL = 'francisdominic261@gmail.com';
const OUT = '/tmp/onlyfaucet-diag';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${m}`);

const failed = [];
const captchaReqs = [];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

const page = ctx.pages()[0] || (await ctx.newPage());

page.on('requestfailed', (req) => {
  failed.push({ url: req.url().slice(0, 250), err: req.failure()?.errorText });
});
page.on('response', async (res) => {
  const url = res.url();
  if (/captcha|puzzle|verify|slider|drag|webjs|bmcdn|hcaptcha|recaptcha|turnstile|challenge/i.test(url)) {
    captchaReqs.push({ status: res.status(), url: url.slice(0, 250), type: res.request().resourceType() });
  }
});
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const t = msg.text();
    if (/captcha|canvas|shadow|bmcdn|verify|puzzle|failed|blocked|integrity/i.test(t)) {
      log(`CONSOLE: ${t.slice(0, 250)}`);
    }
  }
});
page.on('pageerror', (err) => log(`PAGEERROR: ${err.message.slice(0, 200)}`));

async function dumpDom(label) {
  const info = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const shadows = [...document.querySelectorAll('*')].filter(el => el.shadowRoot).map(el => ({
      id: el.id, tag: el.tagName,
      canvas: !!el.shadowRoot.querySelector('canvas'),
      html: el.shadowRoot.innerHTML.slice(0, 800),
      childTags: [...el.shadowRoot.children].map(c => c.tagName).slice(0, 20),
    }));
    return {
      url: location.href,
      snippet: text.slice(0, 1000),
      hasLogout: text.includes('Logout'),
      hasVerification: text.includes('Verification Required'),
      hasClaimNow: /Claim Now/i.test(text),
      hasCaptchaSelect: !!document.querySelector('#selectCaptcha'),
      captchaSelectVal: document.querySelector('#selectCaptcha')?.value || null,
      captchaOptions: [...document.querySelectorAll('#selectCaptcha option')].map(o => ({v:o.value,t:o.text})),
      cb: [...document.querySelectorAll('[id^="cb_"]')].map(el => ({
        id: el.id, tag: el.tagName, text: (el.innerText||'').slice(0,60),
        rect: (()=>{const r=el.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()
      })),
      h_hosts: [...document.querySelectorAll('[id^="h_"]')].map(el => ({
        id: el.id, hasShadow: !!el.shadowRoot,
        canvas: el.shadowRoot ? !!el.shadowRoot.querySelector('canvas') : false,
        shadow: el.shadowRoot ? el.shadowRoot.innerHTML.slice(0, 500) : null,
      })),
      allShadows: shadows,
      captchaDivs: [...document.querySelectorAll('.captcha, [class*=captcha], [id*=captcha], [id*=puzzle], [class*=puzzle]')].map(el => ({
        id: el.id, cls: el.className?.toString?.().slice(0,80), tag: el.tagName,
        display: getComputedStyle(el).display,
        text: (el.innerText||'').slice(0,100),
        html: el.innerHTML.slice(0, 400),
      })),
      iframes: [...document.querySelectorAll('iframe')].map(f => ({
        src: (f.src||'').slice(0,180), id: f.id,
        rect: (()=>{const r=f.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()
      })),
      captchaScripts: [...document.querySelectorAll('script[src]')].map(s => s.src).filter(s => /captcha|puzzle|webjs|verify/i.test(s)),
      allScripts: [...document.querySelectorAll('script[src]')].map(s => s.src).slice(0, 40),
      forms: [...document.querySelectorAll('form')].map(f => ({
        action: f.action, id: f.id, method: f.method,
        inputs: [...f.querySelectorAll('input,button,select')].map(i => ({name:i.name,id:i.id,type:i.type,val:(i.value||'').slice(0,40)}))
      })),
      canvases: [...document.querySelectorAll('canvas')].map(c => ({id:c.id,w:c.width,h:c.height})),
    };
  });
  writeFileSync(`${OUT}/${label}.json`, JSON.stringify(info, null, 2));
  log(`[${label}] logout=${info.hasLogout} verif=${info.hasVerification} claimNow=${info.hasClaimNow} shadows=${info.allShadows.length} cb=${info.cb.length} h=${info.h_hosts.length} captchaDivs=${info.captchaDivs.length}`);
  if (info.captchaDivs.length) log(`  captchaDivs: ${JSON.stringify(info.captchaDivs.map(d=>({id:d.id,cls:d.cls,disp:d.display,text:d.text.slice(0,60)})))}`);
  if (info.allShadows.length) log(`  shadows: ${JSON.stringify(info.allShadows.map(s=>({id:s.id,canvas:s.canvas,child:s.childTags})))}`);
  if (info.captchaOptions.length) log(`  selectCaptcha: ${JSON.stringify(info.captchaOptions)} val=${info.captchaSelectVal}`);
  if (info.cb.length) log(`  cb: ${JSON.stringify(info.cb)}`);
  log(`  forms: ${JSON.stringify(info.forms.map(f=>({a:f.action,ins:f.inputs.map(i=>i.name||i.id)})))}`);
  return info;
}

try {
  // Home
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);
  let info = await dumpDom('01-home');

  // Login if needed
  if (!info.hasLogout) {
    log('Logging in...');
    await page.click('text=Login / Register').catch(e => log(`login click: ${e.message}`));
    await sleep(2000);
    await page.fill('#walletInput', EMAIL).catch(e => log(`fill: ${e.message}`));
    await sleep(500);
    await page.click('button:has-text("Continue"), button[type="submit"]').catch(e => log(`submit: ${e.message}`));
    await sleep(6000);
    info = await dumpDom('02-after-login');
  }

  // Faucet
  await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/03-faucet.png`, fullPage: true });
  info = await dumpDom('03-faucet');

  // If Claim Now present, try submitting form first
  if (info.hasClaimNow) {
    log('Claim Now present — submitting form...');
    const submitted = await page.evaluate(() => {
      const forms = [...document.querySelectorAll('form')];
      for (const f of forms) {
        if (/faucet/i.test(f.action) || f.querySelector('[name*=claim], [id*=claim]')) {
          f.submit();
          return f.action;
        }
      }
      // fallback: click claim button
      const btn = [...document.querySelectorAll('button, a, input[type=submit]')].find(b => /claim/i.test(b.innerText||b.value||''));
      if (btn) { btn.click(); return 'click:'+(btn.innerText||btn.value); }
      return null;
    });
    log(`Submitted: ${submitted}`);
    await sleep(8000);
    info = await dumpDom('04-after-claim-click');
    await page.screenshot({ path: `${OUT}/04-after-claim.png`, fullPage: true });
  }

  // If verification needed, click cb_ button
  if (info.hasVerification || info.cb.length > 0) {
    log('Verification required — clicking...');
    await page.evaluate(() => {
      document.querySelectorAll('[class^="cc-"]').forEach(el => el.remove());
      document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' });
    });
    await sleep(800);
    const box = await page.evaluate(() => {
      const el = document.querySelector('[id^="cb_"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    });
    if (box) {
      log(`Click at (${Math.round(box.x)},${Math.round(box.y)})`);
      await page.mouse.move(box.x, box.y, {steps:5});
      await sleep(200);
      await page.mouse.click(box.x, box.y);
    }

    for (let i = 1; i <= 10; i++) {
      await sleep(3000);
      info = await dumpDom(`05-after-click-${i}`);
      if (info.allShadows.some(s => s.canvas) || info.canvases.length > 0) {
        log('CANVAS FOUND!');
        await page.screenshot({ path: `${OUT}/06-canvas.png`, fullPage: false });
        break;
      }
      if (i === 1 || i === 10) {
        await page.screenshot({ path: `${OUT}/05-after-click-${i}.png`, fullPage: true });
      }
    }
  }

  // Dump page HTML around captcha for analysis
  const html = await page.content();
  writeFileSync(`${OUT}/page.html`, html);
  log(`Saved page.html (${html.length} bytes)`);
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
}

log('--- Failed requests ---');
failed.filter(f => /captcha|puzzle|bmcdn|webjs|verify/i.test(f.url)).forEach(f => log(`FAIL ${f.err}: ${f.url}`));
log('--- Captcha responses ---');
captchaReqs.forEach(r => log(`${r.status} [${r.type}] ${r.url}`));
writeFileSync(`${OUT}/failed.json`, JSON.stringify(failed, null, 2));
writeFileSync(`${OUT}/captcha-reqs.json`, JSON.stringify(captchaReqs, null, 2));

await ctx.close().catch(() => {});
log('Done');
process.exit(0);
