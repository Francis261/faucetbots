import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const PASSWORD = 'Frank986532';
const BASE = 'https://adbtc.top';
const STATE_FILE = 'session.json';
const USE_PROXY = process.argv.includes('--proxy');
const RESOLVER = 'MAP brunhild.challenges.cloudflare.com 104.18.94.41, MAP challenges.cloudflare.com 104.18.94.41';
const REAL_PROFILE = process.argv.includes('--profile') || !process.argv.includes('--temp');
const PROFILE_DIR = join(homedir(), '.config/google-chrome');
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'adbch-'));

const userDataDir = REAL_PROFILE ? PROFILE_DIR : TEMP_DIR;
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1366, height: 768 },
  locale: 'en-US',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--host-resolver-rules=${RESOLVER}`],
});
if (USE_PROXY) context.setProxy({ server: 'socks5://127.0.0.1:1081' });
if (existsSync(STATE_FILE)) {
  await context.addCookies(JSON.parse(readFileSync(STATE_FILE, 'utf-8')));
}
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = context.pages()[0] || (await context.newPage());

const CHECKBOX_SELECTORS = [
  '[role="checkbox"]',
  'input[type="checkbox"]',
  '.ctp-checkbox',
  '.ctp-checkbox-label',
  'label[class*="checkbox"]',
  '[class*="checkbox"]',
  '.challenge-box',
  '[id*="challenge"] button',
  '#challenge-stage button',
  '.cf-turnstile input',
  'button[class*="ctp"]',
];

async function clickInFrame(frame) {
  for (const sel of CHECKBOX_SELECTORS) {
    const loc = frame.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      const vis = await loc.isVisible().catch(() => false);
      if (vis) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        console.log(`  [CLICKED] "${sel}" in ${frame === page.mainFrame() ? 'TOP page' : 'iframe'}`);
        return true;
      }
    }
  }
  return false;
}

async function clickAnyCheckbox() {
  if (await clickInFrame(page.mainFrame())) return true;
  for (const f of page.frames()) {
    if (f !== page.mainFrame()) {
      if (await clickInFrame(f)) return true;
    }
  }
  return false;
}

async function isLoginFormVisible() {
  try {
    const url = page.url();
    if (url.includes('__cf_chl')) return false;
    const count = await page.locator('input#addr, input#secret, #submit_btn, input[type="submit"], form input[type="password"]').count();
    return count >= 2;
  } catch {
    return false;
  }
}

async function waitForLoginForm() {
  for (let i = 0; i < 120; i++) {
    if (await isLoginFormVisible()) {
      console.log(`  [OK] login form visible after ~${i * 5}s`);
      return true;
    }
    if (await alreadyLoggedIn()) {
      console.log('   ALREADY LOGGED IN — skipping login form.');
      return true;
    }
    const clicked = await clickAnyCheckbox();
    if (!clicked && i % 2 === 0) {
      console.log(`  iter ${i + 1}/120 (${(i + 1) * 5}s): no checkbox yet, waiting...`);
    }
    await page.waitForTimeout(5000);
  }
  return false;
}

async function saveSession() {
  writeFileSync(STATE_FILE, JSON.stringify(await context.cookies(), null, 2));
}

async function waitForChallenge(label) {
  for (let i = 0; i < 120; i++) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const onChallenge = title.includes('Just a moment') || bodyText.includes('Performing security verification');
    if (!onChallenge) {
      console.log(`  ${label}: challenge cleared after ~${i * 5}s`);
      return true;
    }
    const clicked = await clickAnyCheckbox();
    if (!clicked && i % 4 === 0) console.log(`  iter ${i + 1}/120: still challenging, no checkbox yet...`);
    await page.waitForTimeout(5000);
  }
  return false;
}

async function alreadyLoggedIn() {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return bodyText.includes('Your id:') || bodyText.includes('Rating:');
}

async function doLogin() {
  console.log('2. Looking for "Log in" button...');
  await page.waitForSelector('a.btn-large[href="/index/enter"]', { timeout: 60000 });
  await page.click('a.btn-large[href="/index/enter"]');
  await page.waitForLoadState('domcontentloaded');

  console.log('3. Waiting for Cloudflare challenge to clear...');
  await waitForChallenge('login page');
  await saveSession();

  if (await alreadyLoggedIn()) {
    console.log('   ALREADY LOGGED IN after challenge — skipping login form.');
    return;
  }

  await waitForLoginForm();

  if (await alreadyLoggedIn()) {
    console.log('   ALREADY LOGGED IN — skipping login form.');
    return;
  }

  const formDump = await page.evaluate(() =>
    [...document.querySelectorAll('input, button')].map(e => ({
      tag: e.tagName, type: e.type, name: e.name, id: e.id, cls: e.className, value: e.value,
    }))
  );
  console.log('4. Login form fields found:', JSON.stringify(formDump));

  const emailField = page.locator('input#addr').first();
  const passField = page.locator('input#secret').first();
  const useFound = (await emailField.count()) > 0 && (await passField.count()) > 0;
  if (!useFound) throw new Error('Login form fields (input#addr / input#secret) not present');

  await emailField.fill(EMAIL);
  await passField.fill(PASSWORD);

  console.log('5. Submitting login form...');
  const submit = page.locator('#submit_btn, input[type="submit"]').first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    submit.click(),
  ]);
  await page.waitForTimeout(5000);
  await saveSession();
}

try {
  console.log('1. Opening home page...');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForChallenge('home page');
  await saveSession();

  if (await alreadyLoggedIn()) {
    console.log('   ALREADY LOGGED IN — skipping login form.');
    await page.screenshot({ path: 'after-login.png' });
  } else {
    await doLogin();
  }

  const url = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const loggedIn = (await alreadyLoggedIn()) && !url.includes('/enter');
  console.log('6. Current URL:', url);
  console.log(loggedIn ? 'LOGIN SUCCESS' : 'LOGIN FAILED / STILL ON LOGIN PAGE');
  if (!loggedIn) console.log('--- page text (first 1500) ---\n' + bodyText.slice(0, 1500));
} catch (err) {
  console.error('ERROR:', err.message);
  await page.screenshot({ path: 'error.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context.close();
}
