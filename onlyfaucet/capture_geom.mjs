// Intercept the widget's own /faucet/captcha_image response (read-only):
// saves the pristine background PNG and prints the X-Captcha-Piece geometry.
import { writeFileSync } from 'node:fs';
import { launchBrowser, gotoRetry, ensureCleared, isLoggedIn, login, getPageState, sleep, log, BASE_URL, FAUCET_URL, SHOT_DIR, loadAccounts } from './bot.mjs';

const OUT = process.env.CAP_OUT || `${SHOT_DIR}/geom`;
const email = process.env.LOGIN_EMAIL || process.env.EMAIL || loadAccounts()[0]?.email;
const captured = [];

const ctx = await launchBrowser();
try {
  const page = ctx.pages()[0] || (await ctx.newPage());

  // Observe the background blob the widget loads (identical bytes the page uses).
  await ctx.addInitScript(() => {
    try {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (obj) => {
        try {
          if (obj instanceof Blob && obj.size > 0) {
            obj.arrayBuffer().then(buf => {
              let bin = '';
              const bytes = new Uint8Array(buf);
              const CH = 0x8000;
              for (let i = 0; i < bytes.length; i += CH) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
              }
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
      let body = Buffer.alloc(0);
      let bodyErr = null;
      try { body = await res.body(); } catch (e) { bodyErr = e.message.slice(0, 80); }
      const n = captured.length;
      const png = `${OUT}-bg-${n}.png`;
      if (body.length) writeFileSync(png, body);
      let geom = null;
      try { geom = JSON.parse(Buffer.from(hdr || '', 'base64').toString('utf8')); } catch {}
      if (geom && geom.sprite) {
        try {
          const sp = Buffer.from(String(geom.sprite).replace(/^data:image\/png;base64,/, ''), 'base64');
          writeFileSync(`${OUT}-sprite-${n}.png`, sp);
          log(`sprite saved (${sp.length} bytes) at (${geom.x},${geom.y}) -> ${OUT}-sprite-${n}.png`);
        } catch (e) { log(`sprite decode err: ${e.message}`); }
      }
      const summary = {
        status: res.status(),
        hdrBytes: hdr ? hdr.length : 0,
        bodyBytes: body.length,
        headers: {
          'content-type': res.headers()['content-type'],
          'content-length': res.headers()['content-length'],
          'content-encoding': res.headers()['content-encoding'],
          'cache-control': res.headers()['cache-control'],
        },
        png,
        geomKeys: geom ? Object.keys(geom) : null,
        geom: geom ? { ...geom, sprite: geom.sprite ? `<${geom.sprite.length} b64 chars>` : undefined } : null,
      };
      captured.push(summary);
      log(`CAPTCHA_IMAGE ${JSON.stringify(summary)}`);
    } catch (e) {
      log(`capture err: ${e.message}`);
    }
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

  // Open the widget — and close/reload fast if we do not solve (50s forceFail)
  const started = Date.now();
  let opened = false;
  for (let i = 0; i < 8 && !opened; i++) {
    const st = await getPageState(page);
    log(`iter ${i}: verif=${st.verification} puzzle=${st.puzzle} claimBtn=${st.claimBtn} cb=${!!st.cbRect} cooldown=${st.cooldown} blocked=${st.temporarilyBlocked} captchaErr=${st.captchaError}`);
    if (st.puzzle) { opened = true; break; }
    if (st.verification && st.cbRect) {
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const cb = await getPageState(page);
      if (cb.cbRect) {
        log('clicking cb_');
        await page.mouse.click(cb.cbRect.x, cb.cbRect.y);
        await sleep(3000);
        continue;
      }
    }
    // Trigger verification by submitting a free claim (no puzzle offered yet)
    if (st.claimBtn && !st.verification && !st.puzzle && !st.cooldown && i >= 2) {
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
  log(`widget opened=${opened} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s captures=${captured.length}`);

  // Pull the pristine background image the widget is drawing
  for (let i = 0; i < 10; i++) {
    const bi = await page.evaluate(() => (window.__ofBlob ? { size: window.__ofBlob.size, type: window.__ofBlob.type, b64: window.__ofBlob.b64 } : null)).catch(() => null);
    if (bi && bi.b64) {
      const p = `${OUT}-bgfull-${captured.length}.png`;
      writeFileSync(p, Buffer.from(bi.b64, 'base64'));
      log(`pristine background saved: ${bi.size} bytes type=${bi.type} -> ${p}`);
      break;
    }
    await sleep(500);
  }

  // Widget canvas box + rendered size (to verify 450x280 scaling)
  const boxInfo = await page.evaluate(() => {
    const h = document.querySelector('[id^="h_"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    const form = h.closest('form');
    const ans = form ? form.querySelector('[id^="ca_"]') : null;
    return { x: r.x, y: r.y, w: r.width, h: r.height, answerVal: ans ? ans.value : null };
  }).catch(() => null);
  log(`box ${JSON.stringify(boxInfo)}`);
  if (boxInfo) {
    const shot = await page.screenshot({
      clip: { x: Math.max(0, boxInfo.x), y: Math.max(0, boxInfo.y), width: Math.min(boxInfo.w, 1280), height: Math.min(boxInfo.h, 800) },
    }).catch(() => null);
    if (shot) { writeFileSync(`${OUT}-widget-${captured.length}.png`, shot); log(`widget screenshot ${shot.length} bytes`); }
  }

  writeFileSync(`${OUT}-summary.json`, JSON.stringify({ captured, boxInfo }, null, 2));

  // Always leave before the 50s forceFail can fire — never burn an attempt.
  const elapsed = Date.now() - started;
  log(`reloading before forceFail (elapsed ${(elapsed / 1000).toFixed(1)}s) — no attempt`);
  await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
} catch (e) {
  log(`ERROR ${e.stack || e.message}`);
} finally {
  await ctx.close().catch(() => {});
}
process.exit(0);
