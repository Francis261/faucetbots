// Read-only DOM probe — NO widget is opened (no checkbox click, no burst risk).
//   node probe_dom.mjs
// 1. dumps the live faucet page HTML (inline widget script inspection)
// 2. reports elementsFromPoint stacks at the widget region (clip is stable:
//    x=542, y=273, w=406, h=254 today) to find invisible interactive overlays
import { writeFileSync } from 'node:fs';
import { launchBrowser, gotoRetry, ensureCleared, isLoggedIn, login, sleep, log, BASE_URL, FAUCET_URL, SHOT_DIR, loadAccounts } from './bot.mjs';

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

  const out = `${SHOT_DIR}/page-live.html`;
  const html = await page.content();
  writeFileSync(out, html);
  log(`wrote ${out} (${html.length} bytes)`);

  // Widget region in viewport coords (stable across today's runs) + the
  // expected press point for piece canvas(76,189): clip->page = 542+1+76*404.5/450
  const pts = [
    ['widget-center', 745, 400],
    ['piece-press', 612, 443],
    ['widget-top-left', 560, 295],
  ];
  for (const [name, x, y] of pts) {
    const stack = await page.evaluate(([px, py]) =>
      (document.elementsFromPoint(px, py) || []).slice(0, 6).map(el => {
        const r = el.getBoundingClientRect();
        const cls = typeof el.className === 'string' ? el.className : '';
        const cs = getComputedStyle(el);
        return `${el.tagName}#${el.id || '-'}.${cls.trim().split(/\s+/).slice(0, 2).join('.')}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} z=${cs.zIndex} pe=${cs.pointerEvents} pos=${cs.position}`;
      }).join(' | '), [x, y]).catch(e => `err:${e.message}`);
    log(`${name} (${x},${y}): ${stack}`);
  }

  // Widget script host-id prefix: search the inline script for id generation.
  const hits = [];
  for (const m of html.matchAll(/["'`]([a-z]{1,3})_["'`]|getElementById\(["'`]([a-z]+)_|\bid\s*=\s*["'`]([a-z]{1,3})_/g)) {
    const p = m[1] || m[2] || m[3];
    if (p) hits.push(p);
  }
  const uniq = [...new Set(hits)];
  log(`id prefixes in page: ${uniq.join(', ')}`);
} catch (e) {
  log(`probe_dom failed: ${e.message}`);
} finally {
  await ctx.close().catch(() => {});
  process.exit(0);
}
