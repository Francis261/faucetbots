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

// intercept network requests for captcha
const captchaUrls = [];
page.on('request', req => {
  const url = req.url();
  if (url.includes('captcha') || url.includes('cc-') || url.includes('challenge') || url.includes('bitmedia') || url.includes('ccid')) {
    captchaUrls.push(url.slice(0, 150));
  }
});

// login
await page.goto('https://moonptc.com/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="email"]', EMAIL);
await page.click('button:has-text("Start Earning")', { timeout: 10000 });
await page.waitForTimeout(5000);

// faucet
await page.goto('https://moonptc.com/faucet', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// find captcha scripts
console.log('=== captcha network requests ===');
captchaUrls.forEach(u => console.log(u));

// check page scripts
const scripts = await page.evaluate(() => {
  const scripts = [...document.querySelectorAll('script')];
  return scripts.map(s => ({
    src: s.src?.slice(0, 120) || '',
    text: s.textContent?.slice(0, 200) || '',
    type: s.type || '',
  })).filter(s => s.src || s.text.includes('captcha') || s.text.includes('cc-') || s.text.includes('2524'));
});
console.log('\n=== captcha scripts ===');
scripts.forEach(s => console.log(JSON.stringify(s)));

// check for captcha.com specific elements
const ccInfo = await page.evaluate(() => {
  // check for window.__cc or similar
  const globals = {};
  for (const key of Object.keys(window)) {
    if (key.includes('cc') || key.includes('captcha') || key.includes('Captcha')) {
      try { globals[key] = typeof window[key]; } catch(e) {}
    }
  }
  
  // check for captcha div with shadow root
  const ccDiv = document.querySelector('[data-cc-id]');
  const hasShadow = ccDiv?.shadowRoot !== null;
  
  // check all divs with data-format
  const dataFormats = [...document.querySelectorAll('[data-format]')].map(e => ({
    format: e.dataset.format, ccId: e.dataset.ccId, html: e.outerHTML.slice(0, 200),
    shadow: e.shadowRoot !== null, children: e.children.length,
  }));
  
  return { globals, hasShadow, dataFormats };
});
console.log('\n=== cc info ===');
console.log(JSON.stringify(ccInfo, null, 1));

// check the React app's state for captcha
const reactState = await page.evaluate(() => {
  const root = document.getElementById('root');
  const fiber = root?._reactRootContainer?._internalRoot?.current;
  // try to find captcha-related state
  const findCaptcha = (node, depth = 0) => {
    if (depth > 10 || !node) return null;
    if (node.memoizedProps?.captcha || node.memoizedProps?.ccId) {
      return { props: Object.keys(node.memoizedProps || {}).join(','), type: typeof node.type === 'string' ? node.type : node.type?.name };
    }
    let child = node.child;
    while (child) {
      const found = findCaptcha(child, depth + 1);
      if (found) return found;
      child = child.sibling;
    }
    return null;
  };
  const found = findCaptcha(fiber);
  return { hasFiber: !!fiber, captchaState: found };
});
console.log('\n=== react state ===');
console.log(JSON.stringify(reactState, null, 1));

// intercept XHR/fetch responses for captcha token
page.on('response', async resp => {
  const url = resp.url();
  const ct = resp.headers()['content-type'] || '';
  if ((url.includes('captcha') || url.includes('cc-') || url.includes('token') || url.includes('verify')) && ct.includes('json')) {
    const body = await resp.json().catch(() => null);
    console.log('\n=== captcha response ===', url.slice(0, 100), JSON.stringify(body).slice(0, 300));
  }
});

// try to click on the captcha by evaluating JS
console.log('\n=== trying to find captcha click handler ===');
const clickResult = await page.evaluate(() => {
  const ccDiv = document.querySelector('[data-cc-id]');
  if (!ccDiv) return 'no cc div';
  
  // check if there's a click handler
  const events = ccDiv.onclick;
  
  // try dispatching a click event
  const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
  ccDiv.dispatchEvent(evt);
  
  return { events: !!events, dispatched: true };
});
console.log('click result:', JSON.stringify(clickResult));

await page.waitForTimeout(5000);

// check state after dispatch
const afterDispatch = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 120), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }));
  const ccDiv = document.querySelector('[data-cc-id]');
  return { iframes, ccHtml: ccDiv?.innerHTML?.slice(0, 200) || '', ccStyle: ccDiv?.style?.cssText || '' };
});
console.log('\n=== after dispatch ===');
console.log(JSON.stringify(afterDispatch, null, 1));

await context.close();