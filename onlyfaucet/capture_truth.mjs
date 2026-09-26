// Read-only ground-truth capture: opens the widget, saves
//   1. the pristine background PNG (blob the widget itself draws),
//   2. the piece sprite + geometry from X-Captcha-Piece,
//   3. a screenshot of the *rendered* widget at the moment the puzzle is up,
// then reloads before the 50s forceFail — never submits, never burns an attempt.
//
// Usage: DISPLAY=:0 node capture_truth.mjs
import { writeFileSync } from 'node:fs';
import { launchBrowser, gotoRetry, ensureCleared, isLoggedIn, login, getPageState, sleep, log, BASE_URL, FAUCET_URL, SHOT_DIR, loadAccounts } from './bot.mjs';

const OUT = process.env.CAP_OUT || `${SHOT_DIR}/truth`;
const email = process.env.LOGIN_EMAIL || process.env.EMAIL || loadAccounts()[0]?.email;
let blobB64 = null, geom = null;

const ctx = await launchBrowser();
try {
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.evaluate(() => { try { window.__ofBlob = null; } catch (e) {} }).catch(() => {});
  await page.addInitScript(() => {
    try {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (obj) => {
        try {
          if (obj instanceof Blob && obj.size > 0) {
            obj.arrayBuffer().then(buf => {
              let bin = '';
              const bytes = new Uint8Array(buf);
              const CH = 0x8000;
              for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
              window.__ofBlob = { b64: btoa(bin), size: bytes.length, type: obj.type };
            }).catch(() => {});
          }
        } catch (e) {}
        return orig(obj);
      };
    } catch (e) {}
  });

  page.on('response', async (res) => {
    if (!res.url().includes('/faucet/captcha_image')) return;
    try {
      const hdr = res.headers()['x-captcha-piece'] || res.headers()['X-Captcha-Piece'] || null;
      if (!hdr) return;
      geom = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
      log(`X-Captcha-Piece keys=${Object.keys(geom)} x=${geom.x} y=${geom.y} sprite=${geom.sprite ? geom.sprite.length : 'none'}`);
      if (geom.sprite) {
        const sp = Buffer.from(String(geom.sprite).replace(/^data:image\/png;base64,/, ''), 'base64');
        writeFileSync(`${OUT}-sprite.png`, sp);
      }
    } catch (e) { log(`geom err ${e.message}`); }
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

  const started = Date.now();
  const MAX_WAIT = 12 * 60 * 1000;
  let opened = false, iter = 0, freeRuns = 0;
  while (!opened && Date.now() - started < MAX_WAIT) {
    iter++;
    const st = await getPageState(page);
    const t = ((Date.now() - started) / 1000).toFixed(1);
    log(`t=${t}s verif=${st.verification} puzzle=${st.puzzle} claimBtn=${st.claimBtn} cb=${!!st.cbRect} cooldown=${st.cooldown} blocked=${st.temporarilyBlocked} blockSec=${st.blockSec} captchaErr=${st.captchaError}`);
    if (st.temporarilyBlocked) { await sleep(20000); continue; }
    freeRuns++;
    if (st.puzzle) { opened = true; break; }
    if (st.verification && st.cbRect) {
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const cb = await getPageState(page);
      if (cb.cbRect) { log('clicking cb_'); await page.mouse.click(cb.cbRect.x, cb.cbRect.y); await sleep(3000); continue; }
    }
    if (st.claimBtn && !st.verification && !st.puzzle && !st.cooldown && freeRuns >= 2) {
      const submitted = await page.evaluate(() => {
        const f = document.querySelector('form[action*="faucet/verify"]');
        if (f) { f.submit(); return 'form'; }
        const b = [...document.querySelectorAll('button')].find(x => /claim now/i.test(x.innerText || ''));
        if (b) { b.click(); return 'click'; }
        return false;
      });
      log(`claim submitted (${submitted}) to trigger verification`);
      await sleep(6000);
      continue;
    }
    await sleep(1500);
  }
  log(`widget opened=${opened} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);

  // pristine background (bytes the page itself is drawing)
  for (let i = 0; i < 12; i++) {
    const bi = await page.evaluate(() => (window.__ofBlob ? { size: window.__ofBlob.size, b64: window.__ofBlob.b64 } : null)).catch(() => null);
    if (bi && bi.b64) { blobB64 = bi.b64; writeFileSync(`${OUT}-bg.png`, Buffer.from(bi.b64, 'base64')); log(`bg saved ${bi.size}B`); break; }
    await sleep(400);
  }

  // scroll the widget fully into view, then shoot it
  const box = await page.evaluate(() => {
    const h = document.querySelector('[id^="h_"]');
    if (!h) return null;
    h.scrollIntoView({ block: 'center', inline: 'center' });
    const r = h.getBoundingClientRect();
    const form = h.closest('form');
    const ans = form ? form.querySelector('[id^="ca_"]') : null;
    return { x: r.x, y: r.y, w: r.width, h: r.height, answerVal: ans ? ans.value : null };
  }).catch(() => null);
  await sleep(600);
  log(`box ${JSON.stringify(box)}`);

  let shotSaved = false;
  if (box) {
    const handle = await page.$('[id^="h_"]').catch(() => null);
    if (handle) {
      const buf = await handle.screenshot({ encoding: 'binary' }).catch(e => { log(`el shot err ${e.message}`); return null; });
      if (buf && buf.length) { writeFileSync(`${OUT}-widget.png`, buf); shotSaved = true; log(`widget element screenshot ${buf.length}B`); }
    }
    if (!shotSaved) {
      const r2 = await page.evaluate(() => { const h = document.querySelector('[id^="h_"]'); const b = h.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }).catch(() => null);
      if (r2) {
        const buf = await page.screenshot({ clip: { x: Math.max(0, r2.x), y: Math.max(0, r2.y), width: r2.w, height: r2.h }, captureBeyondViewport: true }).catch(() => null);
        if (buf && buf.length) { writeFileSync(`${OUT}-widget.png`, buf); shotSaved = true; log(`widget clip screenshot ${buf.length}B`); }
      }
    }
  }

  // full-page shot too, so the widget can be located even if the element shot failed
  const full = await page.screenshot({ encoding: 'binary' }).catch(() => null);
  if (full) writeFileSync(`${OUT}-page.png`, full);

  writeFileSync(`${OUT}-summary.json`, JSON.stringify({ box, geom: geom ? { ...geom, sprite: geom.sprite ? `<${geom.sprite.length}>` : null } : null, blob: blobB64 ? blobB64.length : 0, shotSaved }, null, 2));

  const elapsed = Date.now() - started;
  log(`reloading before forceFail (elapsed ${(elapsed / 1000).toFixed(1)}s) — no attempt`);
  await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
} catch (e) {
  log(`ERROR ${e.stack || e.message}`);
} finally {
  await ctx.close().catch(() => {});
}
process.exit(0);
