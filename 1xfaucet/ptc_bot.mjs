import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAvailableAccount, markClaimed, markCooldown, markError,
  getAccountStats, getNextRetryTime, getDB
} from './accounts_db.mjs';

const BASE_URL = 'https://1xfaucet.com';
const PROFILE = join(process.env.HOME, '.1xfaucet-chrome-profile');
const LOCKFILE = '/tmp/1xfaucet_ptc.lock';

function log(msg) { console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function acquireLock() {
  if (existsSync(LOCKFILE)) {
    const pid = readFileSync(LOCKFILE, 'utf8').trim();
    try { process.kill(Number(pid), 0); } catch {}
    if (existsSync(LOCKFILE)) { console.error(`PTC bot already running (PID ${pid}).`); process.exit(1); }
  }
  writeFileSync(LOCKFILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCKFILE); } catch {} });
}

async function launchBrowser() {
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return ctx;
}

async function isLoggedIn(page) {
  await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);
  return !page.url().includes('/login');
}

async function waitForManualLogin(page) {
  log('Not logged in. Please log in manually.');
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(5000);
    if (!page.url().includes('/login')) { log('Login successful!'); return true; }
    if (i % 12 === 11) log(`Waiting... (${(i+1)*5}s)`);
  }
  return false;
}

async function waitForCloudflare(page, maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const onChallenge = title.includes('moment') || title.includes('Cloudflare') || bodyText.includes('Performing security verification');
    
    if (!onChallenge) return true;
    
    // Try to click the Cloudflare challenge checkbox
    for (const frame of page.frames()) {
      if (frame.url().includes('challenges.cloudflare.com')) {
        try {
          // Click at the checkbox position (typically 25, 33 in the frame)
          await frame.locator('body').click({ position: { x: 25, y: 33 }, timeout: 2000 }).catch(() => {});
        } catch {}
      }
    }
    
    // Also try clicking any checkbox on the main page
    await page.locator('[type="checkbox"], .cf-turnstile').first().click({ timeout: 1000 }).catch(() => {});
    
    await sleep(2000);
  }
  return false;
}

async function getTasksFromTab(page, tabSelector) {
  // Click the tab first
  await page.click(tabSelector).catch(() => {});
  await sleep(2000);

  // Get the tab pane ID from the selector (e.g., 'a[href="#iframe"]' -> 'iframe')
  const tabId = tabSelector.match(/href="#([^"]+)"/)?.[1] || 'all';

  return await page.evaluate((tabId) => {
    // Find the active tab pane
    const pane = document.querySelector('#' + tabId) || document.querySelector('.tab-pane.active');
    if (!pane) return [];
    
    // Find all cards with data-ptc-type attribute
    const cards = pane.querySelectorAll('[data-ptc-type]');
    const tasks = [];
    for (const card of cards) {
      const btn = card.querySelector('button');
      if (!btn) continue;
      
      const ptcType = card.dataset.ptcType;
      const ptcId = card.dataset.ptcId;
      const onclick = btn.getAttribute('onclick') || '';
      
      // Extract URL from onclick (e.g., "window.location = 'https://...'")
      const urlMatch = onclick.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);
      const startUrl = urlMatch ? urlMatch[1] : '';
      
      // For tasks with data-start-url attribute
      if (btn.dataset.startUrl) {
        tasks.push({
          id: btn.dataset.id,
          name: btn.dataset.name,
          url: btn.dataset.url,
          type: btn.dataset.type,
          timer: parseInt(btn.dataset.timer) || 15,
          startUrl: btn.dataset.startUrl,
          verifyUrl: btn.dataset.verifyUrl,
        });
      } else if (startUrl) {
        // For tasks with onclick navigation
        tasks.push({
          id: ptcId,
          name: card.querySelector('.card-title')?.innerText || 'Unknown',
          url: startUrl,
          type: ptcType,
          timer: 15, // Default timer
          startUrl: startUrl,
          verifyUrl: startUrl.replace('/view/', '/verify/'),
        });
      }
    }
    return tasks;
  }, tabId);
}

async function getAllTasks(page) {
  log('Fetching tasks...');
  // Wait for any pending navigation to complete
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await sleep(1000);
  await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'load', timeout: 60000 }).catch(async (e) => {
    log(`Navigation error: ${e.message.slice(0, 50)}`);
    // Try again after a brief delay
    await sleep(5000);
    await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  });
  await waitForCloudflare(page);
  await sleep(3000);

  const windowTasks = await getTasksFromTab(page, 'a[href="#window"]');
  log(`Window tasks: ${windowTasks.length}`);

  const iframeTasks = await getTasksFromTab(page, 'a[href="#iframe"]');
  log(`Iframe tasks: ${iframeTasks.length}`);

  return [...windowTasks, ...iframeTasks];
}

async function doWindowTask(page, task) {
  log(`Window task: ${task.name} (${task.timer}s)`);

  // Click the start button - this opens the modal
  await page.evaluate((startUrl) => {
    const btn = document.querySelector(`button[data-start-url="${startUrl}"]`);
    if (btn) btn.click();
  }, task.startUrl);

  await sleep(3000);

  // Check if modal appeared with "Open ad in new tab" button
  const hasOpenBtn = await page.evaluate(() => {
    const openBtn = document.querySelector('#ptcOpenWindow');
    return openBtn && getComputedStyle(openBtn).display !== 'none';
  });

  if (hasOpenBtn) {
    log('Modal appeared - clicking "Open ad in new tab"...');
    
    // Listen for new page BEFORE clicking
    const newPagePromise = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
    
    // Click the Open button
    await page.evaluate(() => {
      const btn = document.querySelector('#ptcOpenWindow');
      if (btn) btn.click();
    });
    
    const newPage = await newPagePromise;
    
    if (newPage) {
      // Wait for the ad page to load
      log('Waiting for ad page to load...');
      for (let i = 0; i < 30; i++) {
        const url = newPage.url();
        if (url && url !== 'about:blank' && url !== 'chrome://newtab/') {
          log(`Ad page loaded: ${url.slice(0, 60)}`);
          break;
        }
        await sleep(1000);
      }
      
      await newPage.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
      await newPage.bringToFront().catch(() => {});
      
      // Wait for the FULL task timer while staying on ad tab
      // The timer runs on the PTC page while this tab is focused
      log(`Staying on ad tab for ${task.timer}s...`);
      for (let i = 0; i < task.timer; i++) {
        await sleep(1000);
        if (i % 5 === 4) log(`  ${task.timer - i}s remaining...`);
        // Keep the ad tab focused
        await newPage.bringToFront().catch(() => {});
      }
      
      // Extra 3 seconds buffer
      log('Timer done, waiting 3s buffer...');
      await sleep(3);
      
      // Switch back to PTC tab
      await page.bringToFront().catch(() => {});
      log('Switched back to PTC tab');
      
      // Close the ad tab
      await newPage.close().catch(() => {});
      log('Ad tab closed');
    } else {
      log('No ad tab opened');
    }
  } else {
    // No modal - might be direct redirect
    log('No modal - checking for direct redirect...');
    const newPagePromise = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
    const newPage = await newPagePromise;
    
    if (newPage) {
      for (let i = 0; i < 30; i++) {
        const url = newPage.url();
        if (url && url !== 'about:blank' && url !== 'chrome://newtab/') {
          log(`Page loaded: ${url.slice(0, 60)}`);
          break;
        }
        await sleep(1000);
      }
      
      await newPage.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
      await newPage.bringToFront().catch(() => {});
      
      log(`Staying on site for ${task.timer}s...`);
      for (let i = 0; i < task.timer; i++) {
        await sleep(1000);
        if (i % 5 === 4) log(`  ${task.timer - i}s remaining...`);
        await newPage.bringToFront().catch(() => {});
      }
      
      await sleep(3);
      await page.bringToFront().catch(() => {});
      await newPage.close().catch(() => {});
      log('Task window closed');
    }
  }

  await sleep(2000);
}

async function doIframeTask(page, task) {
  log(`Iframe task: ${task.name} (${task.timer}s, ${task.url.slice(0, 40)})`);

  // Click the start button - try data-start-url first, then onclick
  await page.evaluate((startUrl) => {
    // Try button with data-start-url
    let btn = document.querySelector(`button[data-start-url="${startUrl}"]`);
    if (btn) { btn.click(); return; }
    
    // Try button with matching onclick
    const allBtns = document.querySelectorAll('button');
    for (const b of allBtns) {
      const onclick = b.getAttribute('onclick') || '';
      if (onclick.includes(startUrl)) { b.click(); return; }
    }
    
    // Try card with data-ptc-id matching
    const card = document.querySelector(`[data-ptc-id="${startUrl.split('/').pop()}"]`);
    if (card) { card.querySelector('button')?.click(); }
  }, task.startUrl);

  await sleep(2000);

  // Wait for the task timer
  const waitSec = task.timer + 5;
  for (let i = 0; i < waitSec; i++) {
    await sleep(1000);
    if (i % 10 === 9) log(`  ${waitSec - i}s left...`);
  }

  log('Iframe task duration complete');
  await sleep(2000);
}

async function handleVerifyModal(page, task) {
  log('Checking for verification...');
  await sleep(2000);

  // Check if a modal appeared
  const hasModal = await page.evaluate(() => {
    const modals = document.querySelectorAll('.modal.show, .modal[style*="block"]');
    return modals.length > 0;
  });

  if (!hasModal) {
    log('No modal found');
    if (!page.url().includes('/ptc') || page.url().includes('/go/')) {
      await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'load', timeout: 60000 });
      await waitForCloudflare(page);
      await sleep(3000);
    }
    return true;
  }

  log('Modal detected - waiting for Turnstile to load...');

  // IMPORTANT: Make the verify form visible so Turnstile widget can render
  await page.evaluate(() => {
    const form = document.querySelector('#ptcWindowVerifyForm');
    if (form) form.classList.remove('d-none');
  });
  await sleep(2000);
  log('Verify form made visible');

  // Try to reset Turnstile if it exists
  await page.evaluate(() => {
    if (typeof turnstile !== 'undefined') {
      const widget = document.querySelector('.cf-turnstile');
      if (widget) {
        try { turnstile.reset(); } catch {}
      }
    }
  }).catch(() => {});
  await sleep(2000);

  // Wait for Turnstile to appear (it may take a few seconds to load)
  let turnstileFrame = null;
  for (let i = 0; i < 15; i++) {
    turnstileFrame = page.frames().find(f =>
      f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile')
    );
    if (turnstileFrame) {
      log('Turnstile frame found');
      break;
    }
    await sleep(1000);
    log(`  Waiting for Turnstile... (${i + 1}s)`);
  }

  if (turnstileFrame) {
    log('Solving Turnstile...');

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        // Wait for frame to be ready
        await sleep(3000);

        // Find the turnstile iframe element position on the page
        const iframeRect = await page.evaluate(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if ((f.src || '').includes('turnstile') || (f.src || '').includes('challenges.cloudflare')) {
              const r = f.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            }
          }
          // Check cf-turnstile widget container
          const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
          if (widget) {
            const r = widget.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
          return null;
        }).catch(() => null);

        // Always try the .cf-turnstile widget position first (most reliable)
        const widgetRect = await page.evaluate(() => {
          const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
          if (widget) {
            const r = widget.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
          return null;
        }).catch(() => null);

        if (widgetRect && widgetRect.w > 0) {
          // Click at checkbox position: ~(25, center) of the widget
          const cx = widgetRect.x + 25;
          const cy = widgetRect.y + widgetRect.h / 2;
          log(`Clicking Turnstile widget at (${Math.round(cx)}, ${Math.round(cy)})`);
          await page.mouse.move(cx, cy);
          await sleep(500);
          await page.mouse.down();
          await sleep(200);
          await page.mouse.up();
        } else if (iframeRect && iframeRect.w > 0) {
          const cx = iframeRect.x + 25;
          const cy = iframeRect.y + iframeRect.h / 2;
          log(`Clicking Turnstile iframe at (${Math.round(cx)}, ${Math.round(cy)})`);
          await page.mouse.move(cx, cy);
          await sleep(500);
          await page.mouse.down();
          await sleep(200);
          await page.mouse.up();
        } else {
          log('No clickable Turnstile element found');
        }

        // Wait for Turnstile to process and check for token
        for (let w = 0; w < 15; w++) {
          await sleep(1000);
          const solved = await page.evaluate(() => {
            const resp = document.querySelector('[name="cf-turnstile-response"], [name="g-recaptcha-response"]');
            return resp?.value?.length > 10;
          });
          if (solved) {
            log('Turnstile solved!');
            break;
          }
        }

        // Verify solved
        const isSolved = await page.evaluate(() => {
          const resp = document.querySelector('[name="cf-turnstile-response"], [name="g-recaptcha-response"]');
          return resp?.value?.length > 10;
        });

        if (isSolved) {
          // NOW click the Verify button AFTER Turnstile is solved
          log('Clicking Verify button...');
          const verifyClicked = await page.evaluate(() => {
            const modal = document.querySelector('.modal.show, .modal[style*="block"]');
            if (!modal) return false;
            const btns = modal.querySelectorAll('button, a, input[type="submit"]');
            for (const btn of btns) {
              const text = (btn.innerText || btn.value || '').toLowerCase();
              if (text.includes('verify') || text.includes('submit') || text.includes('claim')) {
                btn.click();
                return true;
              }
            }
            return false;
          });
          if (verifyClicked) {
            log('Verify button clicked');
            // Wait for navigation/response
            await sleep(5000);
            // Try to clear old token (may fail if page navigated)
            await page.evaluate(() => {
              const resp = document.querySelector('[name="cf-turnstile-response"], [name="g-recaptcha-response"]');
              if (resp) resp.value = '';
            }).catch(() => {});
          }
          return true;
        } else {
          log(`Turnstile not solved yet (attempt ${attempt + 1})`);
        }
      } catch (e) {
        log(`Turnstile attempt ${attempt + 1} error: ${e.message.slice(0, 60)}`);
      }
      await sleep(2000);
    }

    log('Turnstile failed after all attempts');
  } else {
    log('No Turnstile found in modal');
  }

  // Navigate back to PTC
  await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'load', timeout: 60000 });
  await waitForCloudflare(page);
  await sleep(3000);
  return true;
}

async function run() {
  acquireLock();
  log('=== 1XFaucet PTC Bot Started ===');
  getDB();

  const ctx = await launchBrowser();
  const page = ctx.pages()[0] || (await ctx.newPage());

  // Login check
  if (!(await isLoggedIn(page))) {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'load', timeout: 60000 });
    await sleep(3000);
    if (!(await waitForManualLogin(page))) { await ctx.close(); return; }
  } else {
    log('Already logged in!');
  }

  let round = 0;
  while (true) {
    round++;
    log(`\n=== Round ${round} ===`);

    const tasks = await getAllTasks(page);
    log(`Total tasks: ${tasks.length}`);

    if (tasks.length === 0) {
      log('No tasks available. Waiting 5 min...');
      await sleep(5 * 60 * 1000);
      continue;
    }

    let completed = 0;
    for (const task of tasks) {
      log(`\n--- Task ${completed + 1}/${tasks.length}: ${task.name} ---`);

      try {
        // Make sure we're on the PTC page
        if (!page.url().includes('/ptc') || page.url().includes('/start') || page.url().includes('/verify')) {
          await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'load', timeout: 60000 });
          await waitForCloudflare(page);
          await sleep(3000);
        }

        if (task.type === 'window') {
          await doWindowTask(page, task);
        } else {
          // iframe or external type tasks
          await doIframeTask(page, task);
        }

        // Handle the verify modal
        await handleVerifyModal(page, task);
        completed++;
        log(`Done: ${task.name}`);

        // Force a clean page reload to reset Turnstile state
        // Clear all storage to prevent Turnstile caching
        await page.evaluate(() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
          } catch {}
        }).catch(() => {});
        await page.goto('about:blank', { waitUntil: 'load', timeout: 10000 }).catch(() => {});
        await sleep(3000); // Longer wait to reset Turnstile rate limit
        await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'load', timeout: 60000 });
        await waitForCloudflare(page);
        await sleep(3000);

      } catch (err) {
        log(`ERROR: ${err.message.slice(0, 150)}`);
        // Navigate back to PTC on error
        await page.goto(`${BASE_URL}/ptc`, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await waitForCloudflare(page).catch(() => {});
        await sleep(3000);
      }
    }

    log(`\nRound ${round} complete: ${completed}/${tasks.length} tasks done`);

    // Wait before next round (10 minutes to avoid Turnstile rate limiting)
    log('Waiting 10 min before next round...');
    await sleep(10 * 60 * 1000);
  }
}

await run();
