// Capture-only puzzle sampler: opens the faucet, opens the drag puzzle if offered,
// and screenshots it. NEVER drags or submits — zero CAPTCHA-attempt / ban risk.
//
//   node capture.mjs [count]     (default 3 captures, 120s max)
import { chromium } from 'playwright';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const BASE_URL = 'https://onlyfaucet.com';
const FAUCET_URL = `${BASE_URL}/faucet/currency/usdt`;
const PROFILE = join(process.env.HOME, '.onlyfaucet-chrome-profile');
const OUT = process.env.CAPTURE_OUT || '/tmp/onlyfaucet-puzzles';

const COUNT = Number(process.argv[2] || 3);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${m}`);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const trace = [];

function note(step, data) {
  trace.push({ step, ...data });
  log(`${step}: ${JSON.stringify(data).slice(0, 400)}`);
}

async function getState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const answer = document.querySelector('[name="captcha_answer"]')?.value || '';
    const waitMatch = text.match(/Please wait\s*(\d+):(\d+)/i);
    const waitSec = waitMatch ? Number(waitMatch[1]) * 60 + Number(waitMatch[2]) : null;
    const temporarilyBlocked = /You Have Been Temporarily Blocked|blocked due to multiple failed CAPTCHA/i.test(text);
    let blockSec = null;
    if (temporarilyBlocked) {
      const hm = text.match(/Time remaining to unlock:\s*(\d+)\s*hours?\s*(\d+)\s*minutes?(?:\s*(\d+)\s*seconds?)?/i);
      const mm = text.match(/Time remaining to unlock:\s*(\d+)\s*minutes?\s*(\d+)\s*seconds?/i);
      const ss = text.match(/Time remaining to unlock:\s*(\d+)\s*seconds?/i);
      if (hm) blockSec = Number(hm[1]) * 3600 + Number(hm[2] || 0) * 60 + Number(hm[3] || 0);
      else if (mm) blockSec = Number(hm[1]) * 60 + Number(hm[2] || 0);
      else if (ss) blockSec = Number(ss[1]);
      else blockSec = 3600;
    }
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      url: location.href,
      text: text.slice(0, 600),
      hasLogout: text.includes('Logout') || text.includes('Dashboard'),
      success: text.includes('has been sent'),
      verification: text.includes('Verification Required'),
      puzzle: text.includes('Drag the shape'),
      cooldown: waitSec !== null && !temporarilyBlocked,
      waitSec,
      temporarilyBlocked,
      blockSec,
      claimBtn: /Claim Now/i.test(text),
      captchaError: text.includes('Please complete the captcha'),
      answer,
      cbRect: rect('[id^="cb_"]'),
      hRect: rect('[id^="h_"]'),
      rbRect: rect('[id^="rb_btn_"]'),
      canvasCount: document.querySelectorAll('canvas').length,
      shadowCanvas: [...document.querySelectorAll('*')].filter(e => e.shadowRoot && e.shadowRoot.querySelector('canvas')).length,
    };
  }).catch(e => ({ error: e.message }));
}

function puzzleClip(st) {
  const vp = { width: 1280, height: 800 };
  if (!st?.hRect || st.hRect.w < 80 || st.hRect.h < 80) return null;
  const clip = {
    x: Math.max(0, st.hRect.x),
    y: Math.max(0, st.hRect.y),
    width: Math.min(st.hRect.w, vp.width),
    height: Math.min(st.hRect.h, vp.height),
  };
  if (clip.y + clip.height > vp.height) clip.height = Math.max(50, vp.height - clip.y);
  if (clip.x + clip.width > vp.width) clip.width = Math.max(50, vp.width - clip.x);
  return clip;
}

const EMAIL = process.env.LOGIN_EMAIL || process.env.EMAIL || 'francisdominic261@gmail.com';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu'],
  viewport: { width: 1280, height: 800 },
});
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

try {
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => log(`goto: ${e.message}`));
  await sleep(6000);
  // Let Cloudflare settle if it shows up (read-only wait; no clicking)
  for (let i = 0; i < 10; i++) {
    const t = await page.evaluate(() => (document.body?.innerText || '').slice(0, 200)).catch(() => '');
    if (/Just a moment|Performing security verification/i.test(t)) {
      log('CF challenge visible — waiting (no click)...');
      await sleep(4000);
      continue;
    }
    break;
  }

  // Login if the profile session expired (login by email only — no password on this site)
  let st = await getState(page);
  if (!st.hasLogout && !st.error) {
    note('not-logged-in', { url: st.url });
    await page.click('text=Login / Register').catch(e => note('login-click-err', { e: String(e.message).slice(0, 80) }));
    await sleep(2500);
    const hasWallet = await page.evaluate(() => !!document.querySelector('#walletInput')).catch(() => false);
    note('login-page', { hasWallet, url: page.url() });
    if (hasWallet) {
      await page.fill('#walletInput', EMAIL).catch(() => {});
      await sleep(800);
      await page.click('button:has-text("Continue"), button[type="submit"]').catch(() => {});
      await sleep(6000);
    }
    await page.goto(FAUCET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(5000);
    st = await getState(page);
    note('after-login', st);
  }

  note('faucet-state', st);
  await page.screenshot({ path: `${OUT}/page-${stamp()}.png`, fullPage: true }).catch(() => {});

  if (st.temporarilyBlocked) {
    note('ABORT', { reason: 'temporarily blocked', blockSec: st.blockSec });
    writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace, null, 2));
    await ctx.close().catch(() => {});
    process.exit(2);
  }
  if (st.cooldown) {
    note('ABORT', { reason: 'cooldown', waitSec: st.waitSec });
    writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace, null, 2));
    await ctx.close().catch(() => {});
    process.exit(3);
  }

  // Reach the verification step: submitting the claim form is not a CAPTCHA attempt
  // (only a wrong drag/verify counts toward the ban).
  if (st.claimBtn && !st.verification && !st.puzzle && !st.success) {
    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form[action*="faucet/verify"]');
      if (form) { form.submit(); return 'form'; }
      const btn = [...document.querySelectorAll('button')].find(b => /claim now/i.test(b.innerText || ''));
      if (btn) { btn.click(); return 'click'; }
      return false;
    });
    note('claim-submitted', { submitted });
    await sleep(6000);
    st = await getState(page);
    note('after-claim', st);
    if (st.temporarilyBlocked || st.captchaError) {
      note('ABORT', { reason: st.temporarilyBlocked ? 'blocked after claim submit' : 'captcha error after claim submit', blockSec: st.blockSec });
      writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace, null, 2));
      await ctx.close().catch(() => {});
      process.exit(st.temporarilyBlocked ? 2 : 4);
    }
  }

  // Open the puzzle widget if the verification checkbox is offered (opening it is not an attempt)
  if (!st.puzzle && st.cbRect) {
    await page.evaluate(() => document.querySelector('[id^="cb_"]')?.scrollIntoView({ block: 'center' })).catch(() => {});
    await sleep(500);
    st = await getState(page);
    if (st.cbRect) {
      note('click-cb', st.cbRect);
      await page.mouse.move(st.cbRect.x, st.cbRect.y, { steps: 5 });
      await sleep(250);
      await page.mouse.click(st.cbRect.x, st.cbRect.y);
      await sleep(3000);
    }
  }

  for (let i = 0; i < COUNT; i++) {
    st = await getState(page);
    if (st.temporarilyBlocked) { note('blocked-midway', st); break; }

    // Wait for the widget to render
    let clip = null;
    for (let w = 0; w < 10; w++) {
      st = await getState(page);
      clip = puzzleClip(st);
      if (clip) {
        const probe = await page.screenshot({ clip }).catch(() => null);
        if (probe && probe.length > 8000) {
          const path = `${OUT}/puzzle-${stamp()}-${i}.png`;
          writeFileSync(path, probe);
          note('captured', { path, bytes: probe.length, clip, answer: st.answer, canvas: st.canvasCount, shadowCanvas: st.shadowCanvas });
          appendFileSync(`${OUT}/captured.txt`, `${path}\n`);
          break;
        }
      }
      await sleep(1500);
    }
    if (!clip) note('no-widget', { iteration: i, puzzle: st.puzzle, verification: st.verification, cbRect: st.cbRect, canvas: st.canvasCount });

    if (i < COUNT - 1) {
      // Reset the answer (rb_btn_) so we do not leave a stale answer behind, then re-open.
      if (st.rbRect) await page.evaluate(() => document.querySelector('[id^="rb_btn_"]')?.click()).catch(() => {});
      await sleep(1500);
      if (st.rbRect && st.cbRect) {
        st = await getState(page);
        if (st.cbRect) {
          await page.mouse.click(st.cbRect.x, st.cbRect.y).catch(() => {});
          await sleep(2500);
        }
      }
    }
  }

  st = await getState(page);
  note('final-state', st);
  writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace, null, 2));
} catch (e) {
  note('ERROR', { message: String(e.message || e).slice(0, 300) });
  writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace, null, 2));
} finally {
  await ctx.close().catch(() => {});
}
log('Done (nothing was submitted).');
process.exit(0);
