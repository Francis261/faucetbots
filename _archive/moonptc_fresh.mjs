import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = 'francisdominic261@gmail.com';
const TEMP = mkdtempSync(join(tmpdir(), 'moonptc-'));

const context = await chromium.launchPersistentContext(TEMP, {
  channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="email"]', EMAIL);
await page.click('button:has-text("Start Earning")', { timeout: 10000 });
await page.waitForTimeout(5000);
console.log('logged in');

await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(() => { document.querySelectorAll('[data-cc-id], [class^="cc-"]').forEach(el => el.remove()); });
await page.waitForTimeout(1000);

const challenge = await page.evaluate(async () => {
  const resp = await fetch('/api/faucet/rotation-captcha/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include', body: JSON.stringify({}),
  });
  return await resp.json();
});
console.log('challenge:', JSON.stringify(challenge).slice(0, 300));

if (!challenge.session_id) { console.log('locked or error'); await context.close(); process.exit(1); }

const solution = await page.evaluate(async (ch) => {
  const crop = ch.challenge.crop;
  const loadImg = (src) => new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img); img.onerror = reject; img.src = src;
  });
  const [baseImg, fragImg] = await Promise.all([
    loadImg('/captcha/moon-base.webp'), loadImg(ch.challenge.image),
  ]);
  const size = 400;
  const bc = document.createElement('canvas'); bc.width = size; bc.height = size;
  const bCtx = bc.getContext('2d'); bCtx.drawImage(baseImg, 0, 0, size, size);
  const bData = bCtx.getImageData(0, 0, size, size).data;
  const fc = document.createElement('canvas'); fc.width = size; fc.height = size;
  const fCtx = fc.getContext('2d'); fCtx.drawImage(fragImg, 0, 0, size, size);
  const fData = fCtx.getImageData(0, 0, size, size).data;
  const cx = crop.x * size, cy = crop.y * size, R = crop.radius * size;
  const gp = (d, x, y) => {
    const rx = Math.round(x), ry = Math.round(y);
    if (rx < 0 || rx >= size || ry < 0 || ry >= size) return null;
    const i = (ry * size + rx) * 4; return [d[i], d[i+1], d[i+2]];
  };
  const scores = [];
  for (let angle = 0; angle < 360; angle++) {
    const T = (angle * Math.PI) / 180;
    const cT = Math.cos(T), sT = Math.sin(T);
    let td = 0, n = 0;
    for (let a = 0; a < 360; a += 1) {
      const aR = (a * Math.PI) / 180, cA = Math.cos(aR), sA = Math.sin(aR);
      for (const [iO, oO] of [[-4,4],[-2,2],[-6,6],[-8,8]]) {
        const dx = (R+iO)*cA, dy = (R+iO)*sA;
        const lx = dx*cT + dy*sT, ly = -dx*sT + dy*cT;
        const sx = cx+lx, sy = cy+ly;
        const ox = cx+(R+oO)*cA, oy = cy+(R+oO)*sA;
        const ip = gp(fData, sx, sy), op = gp(bData, ox, oy);
        if (ip && op) { td += Math.abs(ip[0]-op[0])+Math.abs(ip[1]-op[1])+Math.abs(ip[2]-op[2]); n++; }
      }
    }
    scores.push({ angle, score: n > 0 ? td/n : Infinity });
  }
  scores.sort((a, b) => a.score - b.score);
  return { best: scores.slice(0, 10) };
}, challenge);

console.log('top:', solution.best.map(s => s.angle + ':' + s.score.toFixed(1)).join(', '));

const bestAngle = solution.best[0].angle;
const r = await page.evaluate(async (d) => {
  const resp = await fetch('/api/faucet/rotation-captcha/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include', body: JSON.stringify({ session_id: d.sid, angle: d.angle }),
  });
  return await resp.json();
}, { sid: challenge.session_id, angle: bestAngle });
console.log('verify:', JSON.stringify(r));

if (r.ok && r.token) {
  const cr = await page.evaluate(async (t) => {
    const resp = await fetch('/api/faucet/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ captcha_token: t }),
    });
    return await resp.json();
  }, r.token);
  console.log('claim:', JSON.stringify(cr));
  if (cr.ok) console.log('SUCCESS!', cr.finalReward, cr.roll);
} else {
  for (const c of solution.best.slice(1, 4)) {
    console.log('try', c.angle);
    const v = await page.evaluate(async (d) => {
      const resp = await fetch('/api/faucet/rotation-captcha/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ session_id: d.sid, angle: d.angle }),
      });
      return await resp.json();
    }, { sid: challenge.session_id, angle: c.angle });
    console.log('->', JSON.stringify(v));
    if (v.ok && v.token) {
      const cr = await page.evaluate(async (t) => {
        const resp = await fetch('/api/faucet/claim', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify({ captcha_token: t }),
        });
        return await resp.json();
      }, v.token);
      console.log('claim:', JSON.stringify(cr));
      if (cr.ok) console.log('SUCCESS!', cr.finalReward, cr.roll);
      break;
    }
    if (v.error === 'locked') break;
  }
}
await context.close();
