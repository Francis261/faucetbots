// state_probe.mjs — read-only account/page state check.  Loads the faucet
// page and reports getPageState + login status, then exits.  NEVER clicks
// the verification checkbox, never opens a widget: zero attempt risk, zero
// round-spacing events (safe at any time).
//
//   node state_probe.mjs
import {
  launchBrowser, gotoRetry, ensureCleared, getPageState, isLoggedIn,
  sleep, FAUCET_URL,
} from './bot.mjs';

const ctx = await launchBrowser();
let code = 1;
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const nav = await gotoRetry(page, FAUCET_URL);
  await sleep(3000);
  const cleared = await ensureCleared(page);
  let st = await getPageState(page);
  for (let i = 0; i < 6; i++) {
    if (st.claimBtn || st.verification || st.puzzle || st.cooldown
      || st.success || st.temporarilyBlocked || st.navError) break;
    await sleep(1000);
    st = await getPageState(page);
  }
  const loggedIn = await isLoggedIn(page);
  // The green "All banned accounts are..." ticker + any block/verify notices.
  const notices = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return t.split('\n').map(s => s.trim()).filter(s =>
      /banned|blocked|verification|try again|suspended/i.test(s)).slice(0, 8);
  }).catch(() => []);
  console.log('PROBE ' + JSON.stringify({
    nav, cleared, loggedIn,
    url: page.url().slice(0, 80),
    success: st.success ?? null,
    verif: st.verification ?? null,
    puzzle: st.puzzle ?? null,
    cooldown: st.cooldown ?? null,
    waitSec: st.waitSec ?? null,
    claimBtn: st.claimBtn ?? null,
    blocked: st.temporarilyBlocked ?? null,
    blockSec: st.blockSec ?? null,
    navError: st.navError ?? null,
    notices,
  }));
  code = 0;
} catch (e) {
  console.log('PROBE_ERROR ' + e.message.slice(0, 200));
} finally {
  await ctx.close().catch(() => {});
}
process.exit(code);
