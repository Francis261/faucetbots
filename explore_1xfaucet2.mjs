import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--no-sandbox'] });
const page = await browser.newPage();

// Login first
await page.goto('https://1xfaucet.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);

await page.fill('#email', 'francisdominic261@gmail.com');
await page.fill('#password', 'Frank986532');

console.log('Please solve the Turnstile and click Log in...');
console.log('Waiting for redirect (checking every 5s)...');

for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(5000);
  if (!page.url().includes('/login')) {
    console.log('Logged in! URL:', page.url());
    
    // Go to faucet
    await page.goto('https://1xfaucet.com/faucet', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    
    // Click I'M NOT A ROBOT
    await page.click('.ca-captcha-btn').catch(() => console.log('no ca-captcha-btn'));
    await page.waitForTimeout(5000);
    
    // Get full page state
    const state = await page.evaluate(() => {
      const body = document.body?.innerText?.slice(0, 3000);
      
      // Find all modals/overlays
      const modals = [...document.querySelectorAll('[class*="modal"], [class*="popup"], [class*="overlay"], [class*="captcha-modal"]')].filter(el => {
        return el.offsetHeight > 0;
      }).map(el => ({
        class: el.className?.slice(0, 100),
        html: el.innerHTML?.slice(0, 2000)
      }));
      
      // Find rotated image elements
      const rotated = [...document.querySelectorAll('[class*="rotate"], [class*="rotated"], canvas, [class*="slider"]')].map(el => ({
        tag: el.tagName,
        class: el.className?.slice(0, 100),
        id: el.id,
        rect: JSON.parse(JSON.stringify(el.getBoundingClientRect()))
      }));
      
      return { body, modals, rotated };
    });
    
    console.log('=== PAGE STATE ===');
    console.log('Body:', state.body);
    console.log('Modals:', JSON.stringify(state.modals, null, 2));
    console.log('Rotated elements:', JSON.stringify(state.rotated, null, 2));
    
    break;
  }
  if (i % 6 === 5) console.log(`Waiting... (${(i+1)*5}s)`);
}

await browser.close();
