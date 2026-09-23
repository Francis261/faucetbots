import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const URL = 'https://claimfreecoins.io/tether-faucet/';
const PROFILE = '/home/francis/.config/google-chrome';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));

mkdirSync('captcha_db', { recursive: true });
mkdirSync('captcha_db/tiles', { recursive: true });

const useProfile = existsSync(PROFILE);
const context = await chromium.launchPersistentContext(useProfile ? PROFILE : TEMP, {
  channel: 'chrome', headless: false, viewport: { width: 1366, height: 768 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

async function openModal() {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.fill('input#address', EMAIL).catch(() => {});
  await page.click('button[data-target="#captchaModal"]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const visible = await page.locator('#captchaModal').isVisible().catch(() => false);
  if (!visible) {
    await page.evaluate(() => {
      const m = document.querySelector('#captchaModal');
      if (m) {
        m.classList.add('show'); m.style.display = 'block';
        const bd = document.createElement('div');
        bd.className = 'modal-backdrop fade show';
        document.body.appendChild(bd);
      }
    });
    await page.waitForTimeout(500);
  }
}

async function clickCheckboxAndWaitForChallenge() {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const anchor = page.frames().find(f => /api2\/anchor/.test(f.url()));
    if (anchor) {
      const cb = anchor.locator('.recaptcha-checkbox').first();
      if ((await cb.count()) > 0) {
        const checked = (await anchor.locator('.recaptcha-checkbox-checked').count()) > 0;
        if (!checked) {
          await cb.click({ timeout: 3000, force: true }).catch(() => {});
        }
      }
    }
    // check if image challenge appeared
    const challengeDone = page.frames().find(f => /api2\/bframe/.test(f.url()));
    if (challengeDone) {
      const hasTable = await challengeDone.locator('.rc-imageselect-table').count().catch(() => 0);
      if (hasTable > 0) return challengeDone;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function captureChallenge(frame) {
  const data = await frame.evaluate(() => {
    const promptEl = document.querySelector('.rc-imageselect-desc-wrapper, .rc-imageselect-instructions, .rc-imageselect-desc-no-canonical');
    const prompt = promptEl ? promptEl.innerText.slice(0, 200) : (document.title || '');
    const cells = [...document.querySelectorAll('.rc-imageselect-tile, .rc-image-tile-target, table.rc-imageselect-table td')];
    const tiles = [];
    cells.forEach((c, i) => {
      const bg = getComputedStyle(c).backgroundImage;
      const url = (bg.match(/url\("([^"]+)"\)/) || bg.match(/url\('([^']+)'\)/) || bg.match(/url\(([^)]+)\)/))?.[1] || '';
      if (url) tiles.push({ idx: i, url });
    });
    return { prompt, tiles, htmlStart: document.body.innerHTML.slice(0, 200) };
  }).catch(e => ({ err: e.message.slice(0, 200) }));
  return data;
}

console.log('Opening faucet page + modal...');
await openModal();
console.log('Clicking checkbox, waiting for image challenge...');
const challengeFrame = await clickCheckboxAndWaitForChallenge();
if (!challengeFrame) {
  console.log('NO image challenge appeared in 30s (likely still quota-blocked or auto-passed).');
  const anchor = page.frames().find(f => /api2\/anchor/.test(f.url()));
  if (anchor) {
    const txt = await anchor.evaluate(() => document.body.innerText || '').catch(() => '');
    console.log('anchor text:', txt.slice(0, 150));
  }
} else {
  console.log('Challenge frame found:', challengeFrame.url().slice(0, 80));
  const cap = await captureChallenge(challengeFrame);
  console.log('PROMPT:', JSON.stringify(cap.prompt));
  console.log('TILES:', cap.tiles.length);
  cap.tiles.forEach(t => console.log(`  [${t.idx}] ${t.url.slice(0, 90)}`));
  if (cap.tiles.length > 0) {
    const id = Date.now();
    writeFileSync(`captcha_db/puzzle-${id}.json`, JSON.stringify(cap, null, 2));
    appendFileSync('captcha_db/puzzles.jsonl', JSON.stringify({ id, ...cap }) + '\n');
    // download tiles
    for (const t of cap.tiles) {
      const resp = await context.request.get(t.url).catch(() => null);
      if (resp) {
        const buf = await resp.body().catch(() => null);
        if (buf) {
          const ext = (t.url.split('?')[0].match(/\.\w+$/) || ['.png'])[0];
          writeFileSync(`captcha_db/tiles/${id}-${t.idx}${ext}`, buf);
        }
      }
    }
    console.log(`Saved puzzle ${id} + tiles to captcha_db/`);
    console.log('VIEW: open the browser window and click the tiles to solve it manually.');
  }
}
await context.close();