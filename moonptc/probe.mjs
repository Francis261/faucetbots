import { chromium } from 'playwright';

const context = await chromium.launchPersistentContext('/home/francis/.moonptc-probe', {
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = context.pages()[0] || await context.newPage();

const pending = new Map();
page.on('request', (r) => pending.set(r.url(), Date.now()));
page.on('requestfinished', (r) => pending.delete(r.url()));
page.on('requestfailed', (r) => { console.log('FAILED:', r.url().slice(0, 110), r.failure()?.errorText); pending.delete(r.url()); });
page.on('console', (m) => console.log('CONSOLE:', m.type(), m.text().slice(0, 140)));
page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url().slice(0, 110)); });

console.log('navigating...');
try {
  await page.goto('https://moonptc.com/', { waitUntil: 'commit', timeout: 30000 });
  console.log('commit reached');
} catch (e) { console.log('goto failed:', e.message.split('\n')[0]); }

for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const state = await page.evaluate(() => ({
    ready: document.readyState,
    root: document.getElementById('root')?.childElementCount ?? -1,
    text: (document.body?.innerText || '').slice(0, 120),
    url: location.href,
  })).catch((e) => ({ err: e.message.split('\n')[0] }));
  console.log(`t+${(i + 1) * 5}s`, JSON.stringify(state));
  console.log('  pending:', [...pending.keys()].slice(0, 5).map((u) => u.slice(0, 90)));
}

await page.screenshot({ path: '/tmp/moonptc-shots/probe.png' });
await context.close();
