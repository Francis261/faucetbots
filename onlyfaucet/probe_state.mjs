// Read-only state probe: loads the faucet page, prints getPageState, closes
// immediately (well before any widget countdown could force-fail).  Never
// clicks anything.
// Usage: DISPLAY=:0 node probe_state.mjs
import { launchBrowser, gotoRetry, ensureCleared, getPageState, sleep, log, BASE_URL, FAUCET_URL } from './bot.mjs';

const ctx = await launchBrowser();
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (!(await gotoRetry(page, BASE_URL))) throw new Error('home nav failed');
  await sleep(3000);
  await ensureCleared(page);
  if (!(await gotoRetry(page, FAUCET_URL))) throw new Error('faucet nav failed');
  await sleep(4000);
  await ensureCleared(page);
  const st = await getPageState(page);
  log(`state: verif=${st.verification} puzzle=${st.puzzle} claimBtn=${st.claimBtn} cooldown=${st.cooldown} wait=${st.waitSec} blocked=${st.temporarilyBlocked} blockSec=${st.blockSec} captchaErr=${st.captchaError} answer=${JSON.stringify(st.captchaAnswer)} success=${st.success}`);
} finally {
  await ctx.close().catch(() => {});
}
