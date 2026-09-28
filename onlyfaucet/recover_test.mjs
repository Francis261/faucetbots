// Standalone login/recovery test — exercises the CF-challenge + login path
// WITHOUT touching the X-Captcha widget: no cb click, no handlePuzzle, no
// attempt burned, no round-spacing event.  Written to debug the once23
// recovery deadloop (challenge spinner read as "cleared" → navigations kept
// restarting verification until the run was killed).
//
//   node recover_test.mjs
//
// Reads only: profile cookies.  Writes: cf-debug/login screenshots in SHOT_DIR.
import {
  launchBrowser, gotoRetry, ensureCleared, isLoggedIn, login, recoverSession,
  loadAccounts, sleep, log, BASE_URL, FAUCET_URL,
} from './bot.mjs';

const accounts = loadAccounts();
const email = process.env.LOGIN_EMAIL || accounts[0]?.email;
if (!email) { console.error('No accounts'); process.exit(1); }

const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;

const ctx = await launchBrowser();
try {
  const page = ctx.pages()[0] || (await ctx.newPage());

  const home = await gotoRetry(page, BASE_URL);
  log(`TEST home nav=${home} url=${page.url().slice(0, 80)} [${secs()}]`);
  await sleep(3000);
  const cleared = await ensureCleared(page);
  log(`TEST ensureCleared=${cleared} [${secs()}]`);

  if (await isLoggedIn(page)) {
    // Profile session is alive — force the FULL logout -> login cycle so the
    // verified-logout + reconcile-login paths actually get exercised (a
    // logged-in short-circuit tests nothing).
    log('TEST already logged in — forcing full recoverSession cycle');
    const ok = await recoverSession(page, email);
    const in2 = await isLoggedIn(page).catch(() => false);
    log(`TEST recoverSession=${ok} postLoggedIn=${in2} [${secs()}]`);
    process.exitCode = ok && in2 ? 0 : 1;
  } else {
    log('TEST not logged in — running login()');
    const ok = await login(page, email);
    log(`TEST login=${ok} [${secs()}] url=${page.url().slice(0, 80)}`);
    if (ok) {
      // Confirm the session survives the faucet navigation.
      const nav = await gotoRetry(page, FAUCET_URL);
      await sleep(3000);
      await ensureCleared(page);
      const in2 = await isLoggedIn(page);
      log(`TEST faucet nav=${nav} loggedIn=${in2} url=${page.url().slice(0, 80)} [${secs()}]`);
      process.exitCode = in2 ? 0 : 1;
    } else {
      process.exitCode = 1;
    }
  }
} finally {
  await ctx.close().catch(() => {});
}
log(`TEST finished in ${secs()} exit=${process.exitCode}`);
process.exit(process.exitCode ?? 0);
