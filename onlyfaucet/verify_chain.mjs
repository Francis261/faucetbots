// Read-only end-to-end REHEARSAL of the solver: opens the widget exactly the
// way claimFaucet does, runs the real detection pipeline (bg capture ->
// findHolePy -> vision -> consensusGate) and prints the verdict the bot would
// reach — then reloads before the widget's 50s forceFail.
//
// NOTHING is submitted and no attempt is recorded, so this can be run freely
// to validate threshold changes before spending one of the 3 real attempts.
//
// Usage: DISPLAY=:0 node verify_chain.mjs
import { writeFileSync } from 'node:fs';
import {
  launchBrowser, gotoRetry, ensureCleared, isLoggedIn, login, getPageState,
  sleep, log, BASE_URL, FAUCET_URL, SHOT_DIR, loadAccounts,
  getPuzzleBox, clampClip, getCanvasTransform, canvasRectFor,
  freshGeom, freshBgPath, findHolePy, analyzePuzzle, consensusGate, canvasToPage,
  dragCanvas,
} from './bot.mjs';

const email = process.env.LOGIN_EMAIL || process.env.EMAIL || loadAccounts()[0]?.email;
const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

const ctx = await launchBrowser();
try {
  const page = ctx.pages()[0] || (await ctx.newPage());

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
  let opened = false, freeRuns = 0;
  while (!opened && Date.now() - started < MAX_WAIT) {
    const st = await getPageState(page);
    log(`t=${((Date.now() - started) / 1000).toFixed(1)}s verif=${st.verification} puzzle=${st.puzzle} claimBtn=${st.claimBtn} cb=${!!st.cbRect} cooldown=${st.cooldown} blocked=${st.temporarilyBlocked} blockSec=${st.blockSec} captchaErr=${st.captchaError}`);
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
  if (!opened) throw new Error('widget never opened');

  // --- exactly the detection path handlePuzzleContent uses ----------------
  const box = await getPuzzleBox(page);
  if (!box) throw new Error('no puzzle box');
  const clip = clampClip(box, page.viewportSize() || { width: 1280, height: 800 });
  await sleep(500);
  const shotPath = `${SHOT_DIR}/verify-${ts()}.png`;
  const shot = await page.screenshot({ path: shotPath, clip });
  const w = Math.round(clip.width), h = Math.round(clip.height);

  const tr = await getCanvasTransform(page).catch(() => null);
  const rect = canvasRectFor(clip, tr);
  if (!rect) {
    // diagnose: is the host element missing, or did the measure fail?
    const probe = await page.evaluate(() => {
      const h = document.querySelector('[id^="h_"]');
      if (!h) return { h_: false, ids: [...document.querySelectorAll('[id]')].map(e => e.id).slice(0, 30) };
      const r = h.getBoundingClientRect();
      return { h_: true, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    }).catch(e => ({ err: String(e.message || e) }));
    log(`rect=NULL tr=${JSON.stringify(tr)} probe=${JSON.stringify(probe)}`);
  }
  const g = freshGeom();
  const bgPath = await freshBgPath(page, g ? g.at : null);
  log(`clip=${JSON.stringify(clip)} rect=${rect} geom=${g ? `(${g.x},${g.y}) sprite=${g.spritePath}` : 'none'} bg=${bgPath || 'none'}`);

  const holeDet = findHolePy(shotPath, rect, bgPath);
  log(`find_hole: ${JSON.stringify(holeDet)}`);

  let vision = null;
  try { vision = await analyzePuzzle(shot, w, h); log(`Vision: ${JSON.stringify(vision)}`); }
  catch (e) { log(`Vision error: ${e.message.slice(0, 150)}`); }

  const cons = consensusGate(holeDet, vision, w, h);

  // translate the verdict into canvas coords so it can be eyeballed on the bg
  const toCanvas = (x, y) => {
    if (!rect) return { x: null, y: null };
    const [rx, ry, rw, rh] = rect.split(',').map(Number);
    return { x: Math.round(((x - rx) * 450) / rw), y: Math.round(((y - ry) * 280) / rh) };
  };
  const t = cons.primary ? toCanvas(cons.primary.x, cons.primary.y) : { x: null, y: null };
  const pc = toCanvas(cons.pieceX, cons.pieceY);

  const summary = {
    gate: cons.gate,
    wouldSubmit: !!cons.primary,
    src: cons.primary ? cons.primary.src : null,
    targetCanvas: t,
    pieceCanvas: pc,
    detector: holeDet ? `${holeDet.detector}/${holeDet.input}` : null,
    z: holeDet && holeDet.z, z2: holeDet && holeDet.z2,
    margin: cons.pyMargin, support: holeDet && holeDet.support,
    iou0: holeDet && holeDet.iou0, ptdist: holeDet && holeDet.ptdist,
    agreeDist: cons.agreeDist != null ? Math.round(cons.agreeDist) : null,
    visionCanvas: vision ? toCanvas(vision.targetX, vision.targetY) : null,
    bgPath, shotPath, rect,
  };
  writeFileSync(`${SHOT_DIR}/verify-summary.json`, JSON.stringify(summary, null, 2));
  console.log('VERDICT ' + JSON.stringify(summary));

  // --- optional: rehearse the DROP itself (DRAG=1) -------------------------
  // A drag only fills the widget's answer field; the form is submitted by the
  // Confirm button or by the 50s forceFail, neither of which we touch.  So we
  // can compare the widget's own answer with our intended target — the real
  // geometry check — and then reload.
  if (process.env.DRAG === '1' && cons.primary) {
    const tr2 = (await getCanvasTransform(page)) || tr;
    const targetC = t, pieceC = pc;
    if (tr2 && targetC.x != null && pieceC.x != null) {
      const f = canvasToPage(tr2, pieceC.x, pieceC.y);
      const to = canvasToPage(tr2, targetC.x, targetC.y);
      log(`drag rehearsal: piece canvas(${pieceC.x},${pieceC.y}) -> target canvas(${targetC.x},${targetC.y})`);
      // instrument: did pointerdown reach the canvas at all?  (the canvas sits
      // in a CLOSED shadow root on h_*, so we can only watch retargeted events
      // at document level — but clientX/Y survive retargeting.)
      await page.evaluate(() => {
        window.__ptr = [];
        const rec = (e) => window.__ptr.push({
          t: e.type, x: Math.round(e.clientX), y: Math.round(e.clientY),
          trusted: e.isTrusted, tgt: (e.target && (e.target.id || e.target.tagName)) || null,
        });
        for (const t of ['pointerdown', 'pointerup', 'pointercancel']) {
          document.addEventListener(t, rec, true);
        }
      }).catch(() => {});
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        const stack = document.elementsFromPoint(x, y).map(e => e.id || e.tagName);
        return { top: el ? (el.id || el.tagName) : null, stack: stack.slice(0, 5) };
      }, [f.x, f.y]).catch(e => ({ err: String(e.message || e) }));
      log(`press target: ${JSON.stringify(hit)}`);
      await dragCanvas(page, tr2, pieceC, targetC);
      const ans = await page.evaluate(() => {
        const el = document.querySelector('[id^="ca_"]');
        const pt = document.querySelector('[id^="pt_"]');
        return { ca: el ? el.value : null, pt: pt ? pt.value : null };
      }).catch(() => null);
      const ptr = await page.evaluate(() => window.__ptr || []).catch(() => []);
      log(`pointer events: ${JSON.stringify(ptr)}`);
      const ansVal = ans && ans.ca;
      const parsed = ansVal && /^\d+,\d+$/.test(ansVal)
        ? ansVal.split(',').map(Number) : null;
      const drift = parsed ? Math.hypot(parsed[0] - targetC.x, parsed[1] - targetC.y) : null;
      const drag = {
        answer: ansVal,
        grabPassed: !!(ans && ans.pt),
        intended: targetC,
        driftPx: drift != null ? Math.round(drift * 10) / 10 : null,
        pieceAtStart: pieceC,
      };
      summary.drag = drag;
      writeFileSync(`${SHOT_DIR}/verify-summary.json`, JSON.stringify(summary, null, 2));
      console.log('DRAG ' + JSON.stringify(drag));
    } else {
      log('drag rehearsal skipped (no transform / no verdict)');
    }
  }

  log('reloading before forceFail — no attempt submitted');
  await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
} catch (e) {
  log(`ERROR ${e.stack || e.message}`);
} finally {
  await ctx.close().catch(() => {});
}
process.exit(0);
