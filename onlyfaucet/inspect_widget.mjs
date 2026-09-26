// Inspect the drag-puzzle widget: shadow DOM, canvas pixels (full res),
// provider script URLs, and any exposed globals. Never submits an attempt.
import { writeFileSync } from 'node:fs';
import {
  launchBrowser, gotoRetry, ensureCleared, isLoggedIn, login, getPageState,
  getPuzzleBox, dismissSweetAlert, sleep, log, BASE_URL, FAUCET_URL, SHOT_DIR,
  loadAccounts,
} from './bot.mjs';

const OUT = process.env.INSPECT_OUT || `${SHOT_DIR}/inspect`;
const email = process.env.LOGIN_EMAIL || process.env.EMAIL || loadAccounts()[0]?.email;

const ctx = await launchBrowser();
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const reqs = [];
  page.on('response', res => {
    reqs.push(`${res.status()} ${res.request().resourceType()} ${res.url().slice(0, 220)}`);
  });
  if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
  await sleep(3000);
  await ensureCleared(page);
  if (!(await isLoggedIn(page))) {
    if (!(await login(page, email))) throw new Error('login failed');
  } else log('Already logged in');
  if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
  await sleep(4000);
  await ensureCleared(page);

  let st = await getPageState(page);
  log(`state verif=${st.verification} puzzle=${st.puzzle} claimBtn=${st.claimBtn} blocked=${st.temporarilyBlocked} cooldown=${st.cooldown}`);

  // Open the widget whenever the verification checkbox is offered
  for (let i = 0; i < 6; i++) {
    st = await getPageState(page);
    if (st.puzzle || st.hRect) break;
    if (st.verification && st.cbRect) {
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(500);
      const cb = await getPageState(page);
      if (cb.cbRect) {
        log(`clicking cb_ at (${Math.round(cb.cbRect.x)},${Math.round(cb.cbRect.y)})`);
        await page.mouse.move(cb.cbRect.x, cb.cbRect.y, { steps: 4 });
        await sleep(250);
        await page.mouse.click(cb.cbRect.x, cb.cbRect.y);
        await sleep(4000);
        continue;
      }
    }
    await sleep(1500);
  }

  let box = null;
  for (let i = 0; i < 12 && !box; i++) {
    st = await getPageState(page);
    if ((st.puzzle || st.hRect)) box = await getPuzzleBox(page);
    if (!box && i === 2 && st.claimBtn && !st.verification && !st.puzzle && !st.cooldown) {
      // Free claim → may trigger the verification widget
      const submitted = await page.evaluate(() => {
        const f = document.querySelector('form[action*="faucet/verify"]');
        if (f) { f.submit(); return 'form'; }
        const b = [...document.querySelectorAll('button')].find(x => /claim now/i.test(x.innerText || ''));
        if (b) { b.click(); return 'click'; }
        return false;
      });
      log(`claim submitted (${submitted}) to trigger verification`);
      await sleep(6000);
      st = await getPageState(page);
      log(`after claim: verif=${st.verification} puzzle=${st.puzzle} cooldown=${st.cooldown} captchaErr=${st.captchaError}`);
      if (st.cbRect) {
        await page.mouse.click(st.cbRect.x, st.cbRect.y);
        await sleep(4000);
      }
      continue;
    }
    if (!box) { log(`waiting widget ${i + 1}/12 verif=${st.verification} puzzle=${st.puzzle}`); await sleep(2000); }
  }
  if (!box) { log('No widget'); }

  const info = await page.evaluate(() => {
    const res = {
      url: location.href,
      hosts: [...document.querySelectorAll('[id^="h_"]')].map(h => ({ id: h.id, shadow: !!h.shadowRoot })),
      windowKeys: Object.getOwnPropertyNames(window).filter(k =>
        /captcha|puzzle|verify|drag|answer|target|hole|widget|slide|challenge|geo|ck/i.test(k)),
      scripts: [...document.querySelectorAll('script[src]')].map(s => s.src),
      inlineScripts: [...document.querySelectorAll('script:not([src])')]
        .map(s => (s.textContent || '').trim())
        .filter(t => t && /captcha|h_|cb_|canvas|drag|answer|verify/i.test(t))
        .map(t => t.slice(0, 3000)),
      canvasEls: [...document.querySelectorAll('canvas')].map(c => ({ id: c.id, w: c.width, h: c.height })),
      inputs: [...document.querySelectorAll('input,textarea')].map(i => ({
        name: i.name, id: i.id, type: i.type, value: (i.value || '').slice(0, 60),
      })),
    };
    const h = document.querySelector('[id^="h_"]');
    if (h && h.shadowRoot) {
      res.shadowHTML = h.shadowRoot.innerHTML.slice(0, 6000);
      const cs = [...h.shadowRoot.querySelectorAll('canvas')];
      res.shadowCanvases = cs.map(c => ({ id: c.id, cls: c.className, w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight }));
      res.dataURLs = cs.map(c => {
        try { return c.toDataURL('image/png'); } catch (e) { return 'ERR:' + e.message; }
      });
      // any readable element props inside shadow
      res.shadowText = (h.shadowRoot.textContent || '').slice(0, 500);
    }
    return res;
  });

  const { dataURLs, ...rest } = info;
  writeFileSync(`${OUT}-dom.json`, JSON.stringify(rest, null, 2));
  log(`dom: ${JSON.stringify({ ...rest, shadowHTML: rest.shadowHTML?.slice(0, 200), scripts: rest.scripts?.slice(0, 20) }).slice(0, 1500)}`);
  (rest.scripts || []).forEach(s => log(`SCRIPT ${s}`));
  (rest.inlineScripts || []).forEach((t, i) => log(`INLINE[${i}] ${t.slice(0, 1800)}`));
  if (rest.shadowHTML) log(`SHADOW ${rest.shadowHTML.slice(0, 1800)}`);
  (dataURLs || []).forEach((d, i) => {
    if (d.startsWith('ERR:')) { log(`canvas ${i}: ${d}`); return; }
    const buf = Buffer.from(d.split(',')[1], 'base64');
    const p = `${OUT}-canvas-${i}.png`;
    writeFileSync(p, buf);
    log(`canvas ${i}: ${buf.length} bytes -> ${p}`);
  });

  // Network: which scripts did the widget load?
  const interesting = reqs.filter(r => /(script|xhr|fetch|document|websocket|other) /.test(r) && !/ads|clvrads|adsgravity|doubleclick|googlesyndication|analytics|adservice/i.test(r));
  interesting.forEach(r => log(`NET ${r}`));
  writeFileSync(`${OUT}-net.json`, JSON.stringify(reqs, null, 2));
  log('done');
} catch (e) {
  log(`ERROR ${e.stack || e.message}`);
} finally {
  await ctx.close().catch(() => {});
}
process.exit(0);
