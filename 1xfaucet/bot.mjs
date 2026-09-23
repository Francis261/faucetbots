import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAvailableAccount, markClaimed, markCooldown, markError,
  getAccountStats, getNextRetryTime, getDB
} from './accounts_db.mjs';
import { askVision, parseJSON } from './vision.mjs';

const BASE_URL = 'https://1xfaucet.com';
const PROFILE = join(process.env.HOME, '.1xfaucet-chrome-profile');
const TMP = '/tmp/1xfaucet_captcha';
const LOCKFILE = '/tmp/1xfaucet_bot.lock';
mkdirSync(TMP, { recursive: true });

function log(msg) { console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function acquireLock() {
  if (existsSync(LOCKFILE)) {
    const pid = readFileSync(LOCKFILE, 'utf8').trim();
    try { process.kill(Number(pid), 0); } catch {}
    if (existsSync(LOCKFILE)) {
      console.error(`Bot already running (PID ${pid}).`);
      process.exit(1);
    }
  }
  writeFileSync(LOCKFILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCKFILE); } catch {} });
}

async function launchBrowser() {
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--host-resolver-rules=MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41'],
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return ctx;
}

async function isLoggedIn(page) {
  await page.goto(`${BASE_URL}/faucet`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  return !page.url().includes('/login');
}

async function waitForManualLogin(page) {
  log('Not logged in. Please solve Turnstile and click Log in manually.');
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(5000);
    if (!page.url().includes('/login')) { log('Login successful!'); return true; }
    if (i % 12 === 11) log(`Waiting... (${(i+1)*5}s)`);
  }
  return false;
}

function saveBase64Image(base64, path) {
  const b64 = base64.replace(/^data:image\/\w+;base64,/, '');
  writeFileSync(path, Buffer.from(b64, 'base64'));
}

async function solveAntiBotLinks(page) {
  log('Solving anti-bot links...');

  const data = await page.evaluate(() => {
    const form = document.querySelector('form[action*="faucet/verify"]');
    if (!form) return null;
    const alert = form.querySelector('.alert-warning');
    const puzzleImg = alert?.querySelector('img');
    const links = [...form.querySelectorAll('.antibotlinks a')].map(a => ({
      rel: a.getAttribute('rel'),
      imgSrc: a.querySelector('img')?.src || null,
      rect: JSON.parse(JSON.stringify(a.getBoundingClientRect()))
    }));
    const formRect = JSON.parse(JSON.stringify(form.getBoundingClientRect()));
    return { puzzleImgSrc: puzzleImg?.src || null, links, formRect };
  });

  if (!data || !data.puzzleImgSrc) { log('No puzzle found'); return false; }
  const rels = data.links.map(l => l.rel);
  log(`${data.links.length} links: ${rels.join(', ')}`);

  saveBase64Image(data.puzzleImgSrc, join(TMP, 'puzzle.png'));

  const ssPath = join(TMP, 'form_area.png');
  await page.screenshot({
    path: ssPath,
    clip: { x: Math.max(0, data.formRect.x), y: Math.max(0, data.formRect.y), width: data.formRect.width, height: Math.min(data.formRect.height, 500) }
  });

  const linkPaths = [];
  for (let i = 0; i < data.links.length; i++) {
    if (data.links[i].imgSrc) {
      const p = join(TMP, `link_${i}.png`);
      saveBase64Image(data.links[i].imgSrc, p);
      linkPaths.push(p);
    }
  }

  const prompt = [
    'This is a captcha puzzle. A puzzle image shows small numbers in LEFT-to-RIGHT order.',
    `Below are clickable images with numbers. The available numbers are: ${rels.join(', ')}`,
    'The puzzle image shows a SUBSET of these numbers arranged left to right.',
    `Read the puzzle image and return the numbers in LEFT-to-RIGHT order.`,
    `You MUST only return numbers from this list: ${rels.join(', ')}`,
    'Return ONLY JSON: {"order": [num1, num2, num3]}',
    'No explanation.'
  ].join('\n');

  try {
    const response = await askVision(prompt, [ssPath, join(TMP, 'puzzle.png'), ...linkPaths]);
    log(`Vision raw: ${response.slice(0, 300)}`);

    const parsed = parseJSON(response);
    if (!parsed?.order) { log('Unparseable response'); return false; }

    const order = parsed.order;
    log(`Order: ${order.join(' -> ')}`);

    const clicked = [];
    for (const num of order) {
      const idx = data.links.findIndex(l => String(l.rel) === String(num));
      if (idx === -1) { log(`SKIP: ${num} not in [${rels}]`); continue; }
      const link = data.links[idx];
      await page.mouse.click(link.rect.x + link.rect.width/2, link.rect.y + link.rect.height/2);
      clicked.push(link.rel);
      log(`Clicked: ${link.rel}`);
      await sleep(800);
    }

    if (clicked.length !== rels.length) {
      log(`FAILED: ${clicked.length}/${rels.length} links clicked`);
      return false;
    }

    await page.evaluate((val) => {
      const el = document.querySelector('#antibotlinks');
      if (el) el.value = val;
    }, clicked.join(','));

    log(`Anti-bot OK: ${clicked.join(',')}`);
    return true;
  } catch (e) { log(`Vision error: ${e.message}`); return false; }
}

async function solveCoinlyadsCaptcha(page) {
  log('Checking coinlyads captcha...');
  const hasBtn = await page.evaluate(() => !!document.querySelector('.ca-captcha-btn'));
  if (!hasBtn) { log('No captcha button'); return true; }

  await page.click('.ca-captcha-btn').catch(() => {});
  await page.waitForTimeout(3000);

  const cd = await page.evaluate(() => {
    const modals = [...document.querySelectorAll('.modal')].filter(m =>
      m.classList.contains('show') || m.style.display === 'block' ||
      getComputedStyle(m).display !== 'none'
    );
    if (!modals.length) return null;
    const modal = modals[0];
    const imgs = [...modal.querySelectorAll('img')].filter(img => {
      const r = img.getBoundingClientRect();
      return r.width > 20 && r.height > 20;
    }).map((img, i) => ({
      index: i, src: img.src || null,
      rect: JSON.parse(JSON.stringify(img.getBoundingClientRect()))
    }));
    return { images: imgs };
  });

  if (!cd?.images?.length) {
    const token = await page.evaluate(() =>
      document.querySelector('input[name="ca-captcha-response"]')?.value || ''
    );
    if (token.length > 0) { log('Auto-solved!'); return true; }
    log('No captcha modal');
    return true;
  }

  log(`${cd.images.length} captcha images`);
  const imgPaths = [];
  for (const img of cd.images) {
    if (img.src?.startsWith('data:')) {
      const p = join(TMP, `captcha_${img.index}.png`);
      saveBase64Image(img.src, p);
      imgPaths.push(p);
    }
  }
  if (imgPaths.length < 2) return false;

  try {
    const resp = await askVision('Captcha: one image is rotated differently. Which 0-based index is odd? Return ONLY: {"answer": N}', imgPaths);
    const p = parseJSON(resp);
    if (p?.answer === undefined) return false;
    const t = cd.images[p.answer];
    if (t) {
      await page.mouse.click(t.rect.x + t.rect.width/2, t.rect.y + t.rect.height/2);
      await sleep(2000);
      const token = await page.evaluate(() =>
        document.querySelector('input[name="ca-captcha-response"]')?.value || ''
      );
      if (token.length > 0) { log('Captcha solved!'); return true; }
    }
  } catch (e) { log(`Vision error: ${e.message}`); }
  return false;
}

async function claimFaucet(page) {
  log('Checking faucet...');

  const balanceBefore = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const m = text.match(/([\d,.]+)\s*tokens/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
  });

  const status = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return {
      ready: t.includes('Your faucet is ready to claim') || t.includes('Faucet Ready'),
      dailyLimit: t.includes('daily claim limit') || t.includes('come back'),
      claimsLeft: t.match(/(\d+\/\d+)\s*Claims left/)?.[1] || '',
      timer: t.match(/(\d+\s*min)\s*Timer/)?.[1] || ''
    };
  });

  log(`Ready: ${status.ready}, Claims: ${status.claimsLeft}, Timer: ${status.timer}, Bal: ${balanceBefore}`);
  if (status.dailyLimit) return { ok: false, msg: 'DAILY_LIMIT' };
  if (!status.ready) return { ok: false, msg: 'NOT_READY', timer: status.timer };

  if (!await solveAntiBotLinks(page)) return { ok: false, msg: 'ANTIBOT_FAILED' };
  if (!await solveCoinlyadsCaptcha(page)) return { ok: false, msg: 'CAPTCHA_FAILED' };

  log('Submitting...');
  await page.evaluate(() => {
    const form = document.querySelector('form[action*="faucet/verify"]');
    if (form) form.submit();
  });
  await page.waitForTimeout(5000);

  const balanceAfter = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    const m = t.match(/([\d,.]+)\s*tokens/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
  });

  const result = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return {
      hasSuccess: t.includes('successfully') || t.includes('earned') || t.includes('claimed') ||
                  t.includes('CONGRATULATIONS') || t.includes('You have received') || t.includes('tokens credited'),
      hasError: t.includes('error') || t.includes('failed') || t.includes('Too many') ||
                t.includes('invalid') || t.includes('wrong'),
      snippet: t.slice(0, 300)
    };
  });

  log(`Bal: ${balanceBefore} -> ${balanceAfter}`);
  log(`Page: ${result.snippet.slice(0, 150)}`);

  if (result.hasSuccess || balanceAfter > balanceBefore) return { ok: true, msg: 'SUCCESS' };
  if (result.hasError) return { ok: false, msg: 'CLAIM_ERROR' };
  return { ok: false, msg: 'UNKNOWN' };
}

async function run() {
  acquireLock();
  log('=== 1XFaucet Bot Started (Vision) ===');
  getDB();

  const ctx = await launchBrowser();
  const page = ctx.pages()[0] || (await ctx.newPage());

  if (!(await isLoggedIn(page))) {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    if (!(await waitForManualLogin(page))) { await ctx.close(); return; }
  } else { log('Already logged in!'); }

  if (!page.url().includes('/faucet')) {
    await page.goto(`${BASE_URL}/faucet`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  let round = 0;
  while (true) {
    round++;
    log(`\n=== Round ${round} ===`);

    const stats = getAccountStats();
    log(`Accounts: ${stats.total} total, ${stats.active} active, ${stats.cooldown} cooldown`);

    const account = getAvailableAccount();
    if (!account) {
      const nextRetry = getNextRetryTime();
      const waitMs = nextRetry ? Math.max(new Date(nextRetry).getTime() - Date.now(), 30000) : 120000;
      log(`No accounts ready. Waiting ${Math.round(waitMs/60000)} min...`);
      await sleep(waitMs);
      continue;
    }

    log(`Claiming for: ${account.email}`);

    try {
      if (!page.url().includes('/faucet')) {
        await page.goto(`${BASE_URL}/faucet`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
      }
      if (page.url().includes('/login')) {
        log('Session expired!');
        markError(account.email);
        await sleep(300000);
        continue;
      }

      const result = await claimFaucet(page);
      log(`Result: ${result.msg}`);

      if (result.msg === 'SUCCESS') {
        markClaimed(account.email);
        log(`OK: Claimed for ${account.email}`);
      } else if (result.msg === 'DAILY_LIMIT') {
        markCooldown(account.email, 60 * 24);
        log('Daily limit - 24h cooldown');
      } else if (result.msg === 'NOT_READY') {
        markCooldown(account.email, 6);
        log('Not ready - 6 min cooldown');
      } else {
        markError(account.email);
        log(`FAIL: ${result.msg}`);
      }
    } catch (err) {
      log(`ERROR: ${err.message.slice(0, 200)}`);
      markError(account.email);
    }

    await sleep(5000);
  }
}

await run();
