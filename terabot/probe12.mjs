// probe12.mjs — full login card HTML + probe /login route
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36', viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto('https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(6000);
await page.locator('text=Login').first().click({ timeout: 8000 }).catch(()=>{});
await page.waitForTimeout(3000);

const all = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].map(i => ({
    type: i.type, name: i.name, id: i.id, ph: i.placeholder, vis: !!(i.offsetWidth || i.offsetHeight),
  }));
  // login card html: find container holding "Sign in with Google"
  let card = null;
  for (const el of document.querySelectorAll('div,section')) {
    if ((el.innerText || '').includes('Sign in with Google') &&
        (el.innerText || '').includes('Sign up')) { card = el; break; }
  }
  return { inputs, cardHtml: card ? card.outerHTML.slice(0, 3500) : null };
});
console.log('INPUTS:', JSON.stringify(all.inputs, null, 1));
console.log('CARD HTML:\n', all.cardHtml);
await browser.close();
