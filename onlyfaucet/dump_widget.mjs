// Dump the full page HTML (for the inline captcha widget script) to a file.
import { writeFileSync } from 'node:fs';
import { launchBrowser, gotoRetry, ensureCleared, isLoggedIn, login, getPageState, getPuzzleBox, sleep, log, BASE_URL, FAUCET_URL, SHOT_DIR, loadAccounts, roundSpacingLeft, noteRoundStart } from './bot.mjs';

const OUT = process.env.DUMP_OUT || `${SHOT_DIR}/page-dump.html`;
const email = process.env.LOGIN_EMAIL || process.env.EMAIL || loadAccounts()[0]?.email;
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

  // Round spacing: a dump open is a real round event (>=3 in 7min => 1h
  // block). Wait it out up front so the fixed 8-iteration loop below is free
  // to click immediately.
  const preSpacing = roundSpacingLeft();
  if (preSpacing > 0) {
    log(`round spacing: waiting ${Math.round(preSpacing / 1000)}s before opening widget`);
    await sleep(preSpacing + 3000);
  }
  for (let i = 0; i < 8; i++) {
    const st = await getPageState(page);
    if (st.verification && st.cbRect) {
      await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const cb = await getPageState(page);
      if (cb.cbRect) { noteRoundStart(); await page.mouse.click(cb.cbRect.x, cb.cbRect.y); await sleep(3500); }
    }
    const ready = await page.evaluate(() => {
      const h = document.querySelector('[id^="h_"]');
      return !!(h && h.shadowRoot && h.shadowRoot.querySelector('canvas'));
    }).catch(() => false);
    if (ready) { log(`widget ready at iter ${i}`); break; }
    log(`wait widget ${i} verif=${st.verification} puzzle=${st.puzzle} cb=${!!st.cbRect}`);
    await sleep(2000);
  }

  const html = await page.content();
  writeFileSync(OUT, html);
  log(`wrote ${OUT} (${html.length} bytes)`);
} catch (e) {
  log(`ERROR ${e.stack || e.message}`);
} finally {
  await ctx.close().catch(() => {});
}
process.exit(0);
