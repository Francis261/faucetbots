// probe11.mjs — inspect the login card structure (inputs, tabs, buttons)
import { chromium } from 'playwright';
const URL_ = 'https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36', viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
await page.waitForTimeout(6000);

// open the login card from the header
await page.locator('text=Login').first().click({ timeout: 8000 }).catch(async e => {
  console.log('Login click failed:', e.message.slice(0, 120));
});
await page.waitForTimeout(4000);

const dom = await page.evaluate(() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const inputs = [...document.querySelectorAll('input')].filter(visible).map(i => ({
    type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
    autocomplete: i.autocomplete, cls: i.className.slice(0, 60),
  }));
  const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible)
    .map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 50)).filter(Boolean);
  const tabs = [...document.querySelectorAll('[class*=tab],[class*=Tab]')].filter(visible)
    .map(t => (t.innerText || '').trim().slice(0, 40)).filter(Boolean).slice(0, 10);
  const text = (document.body.innerText || '').slice(0, 1200);
  return { inputs, buttons, tabs, text, url: location.href };
});
console.log(JSON.stringify(dom, null, 1));
await browser.close();
