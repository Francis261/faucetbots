import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'faucet-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://claimfreecoins.io/tether-faucet/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input#address', EMAIL).catch(() => {});
await page.click('button[data-target="#captchaModal"]', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const m = document.querySelector('#captchaModal');
  if (m) { m.classList.add('show'); m.style.display = 'block';
    const bd = document.createElement('div'); bd.className = 'modal-backdrop fade show'; document.body.appendChild(bd); }
});

// wait for anchor
let anchor = page.frames().find(f => /api2\/anchor/.test(f.url()));
for (let i = 0; i < 15 && !anchor; i++) { await page.waitForTimeout(1000); anchor = page.frames().find(f => /api2\/anchor/.test(f.url())); }
console.log('anchor:', !!anchor);

// click checkbox
let cbRect = null;
for (let i = 0; i < 10 && !cbRect; i++) {
  cbRect = await anchor.evaluate(() => {
    const box = document.querySelector('#recaptcha-anchor') || document.querySelector('.recaptcha-checkbox');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }).catch(() => null);
  if (!cbRect) await page.waitForTimeout(1000);
}
if (cbRect) {
  const frameEl = await page.evaluate(() => {
    for (const f of [...document.querySelectorAll('iframe')]) {
      if ((f.src || '').includes('api2/anchor')) { const r = f.getBoundingClientRect(); return { x: r.x, y: r.y }; }
    }
    return null;
  });
  if (frameEl) {
    const cx = frameEl.x + cbRect.x + cbRect.w / 2;
    const cy = frameEl.y + cbRect.y + cbRect.h / 2;
    await page.mouse.move(cx, cy); await page.waitForTimeout(200);
    await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
    console.log('clicked at', cx.toFixed(0), cy.toFixed(0));
  }
}

// watch for bframe challenge up to 45s — wait until tiles actually render
let saw = null;
for (let i = 0; i < 45 && !saw; i++) {
  await page.waitForTimeout(1000);
  const bframe = page.frames().find(f => /api2\/bframe/.test(f.url()));
  if (bframe) {
    const info = await bframe.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const tilesCount = document.querySelectorAll('.rc-imageselect-tile, td.rc-imageselect-tile, .rc-image-tile-target').length;
      const imgs = [...document.querySelectorAll('img')].map(i => i.src).filter(s => s && !s.startsWith('data:')).slice(0, 5);
      const bgCells = [...document.querySelectorAll('td, div')].filter(c => (getComputedStyle(c).backgroundImage || '').includes('url(')).slice(0, 5).map(c => ({ cls: c.className, bg: (getComputedStyle(c).backgroundImage||'').slice(0,80) }));
      return { tilesCount, bodyText: bodyText.slice(0, 300), imgs, bgCells };
    }).catch(e => ({ err: e.message.slice(0, 200) }));
    console.log(`poll ${i}: tiles=${info.tilesCount} body="${(info.bodyText||'').trim().slice(0,80)}"`);
    if (info.tilesCount > 0) {
      const detail = await bframe.evaluate(() => {
        const promptEl = document.querySelector('.rc-imageselect-desc-wrapper, .rc-imageselect-instructions, .rc-imageselect-desc-no-canonical, .rc-imageselect-desc, .rc-imageselect-instructions-noclick, .rc-imageselect-payload');
        const prompt = promptEl ? promptEl.innerText.trim() : '';
        const heights = [...document.querySelectorAll('td.rc-imageselect-tile, .rc-imageselect-tile, .rc-image-tile-target')].map(c => {
          const r = c.getBoundingClientRect();
          return { cls: c.className, x: Math.round(r.x), y: Math.round(r.y), w: r.width, h: r.height };
        });
        return { prompt, heights: heights.slice(0, 9) };
      }).catch(e => ({ err: e.message.slice(0, 200) }));
      console.log('TILES DATA:', JSON.stringify(detail));
      saw = bframe;
    }
  }
}
if (!saw) console.log('no bframe appeared');

// dump full bframe html for selector analysis
if (saw) {
  const html = await saw.content().catch(() => '');
  const stripped = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  console.log('--- BFRAME HTML (stripped) ---');
  console.log(stripped.slice(0, 5000));
}
await context.close();