// Origin-down reproduction — the "online device, dead server" case.
//
// The bug this guards: `navigator.onLine` stays true when the server behind the
// proxy/CDN is down, and every request comes back as Cloudflare's "not working"
// HTML page. The app must keep working entirely from the device: cached shell,
// cached reference db, gift log saved to IndexedDB, sync deferred — and it must
// never store a proxy error page as if it were the app.
//
// Self-contained: starts a stub origin + a proxy it can flip into "Cloudflare
// error page" mode, so no real server/CDN is involved.
//
//   node origin-down.js            (from tests/e2e, after `make client-build`)
import { chromium } from 'playwright';
import {
  LIST,
  badges,
  checker,
  log,
  login,
  markFirstGift,
  startStack,
  waitForConnection,
} from './lib/harness.js';

const LOG = log('origin-down');
const { check, failures } = checker(LOG);

/** Is our document (not a proxy page) what the service worker holds? */
const shellCached = (page) =>
  page.evaluate(async () => {
    const keys = await caches.keys();
    for (const k of keys.filter((n) => n.startsWith('acnh-shell-'))) {
      const hit = await (await caches.open(k)).match('/index.html');
      if (hit && (await hit.clone().text()).includes('id="app"')) return true;
    }
    return false;
  });

const stack = await startStack();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem('aboutDismissed', '1'));

try {
  // --- Warm-up: install the SW, cache the shell + reference db --------------
  await login(page, stack.base);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForTimeout(2000); // let install() finish precaching
  check('warm-up: app ready and service worker active', true);
  check('warm-up: shell cached by the service worker', await shellCached(page));

  // --- Origin down, device online ------------------------------------------
  await stack.setMode('down');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(LIST, { timeout: 30000 });
  check('origin down: app still boots from the cached shell', (await page.locator('text=Ace').count()) > 0);
  check('origin down: no Cloudflare page in the document', !(await page.content()).includes('502: Bad gateway'));
  await waitForConnection(page, 'no-server');
  check('origin down: header reports "server unreachable"', true);

  // A gift logged now is device-only: saved locally, sync deferred.
  await page.click('text=Ace');
  await markFirstGift(page);
  await page.waitForTimeout(3000); // debounce (1.5s) + provisional save

  const afterEdit = await badges(page);
  check('origin down: edit saved on device', afterEdit.local === 'saved', JSON.stringify(afterEdit));
  check('origin down: sync stays pending', afterEdit.network === 'pending');
  check('origin down: no upload attempted while unreachable', stack.origin.puts === 0, `puts=${stack.origin.puts}`);

  // The edit must survive a reload.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  const survived = (await page.locator('button[aria-label="Already gifted — undo"]').count()) > 0;
  check('origin down: edit survives a reload', survived);

  // --- Nasty variant: proxy error page with a 200 --------------------------
  // A status check alone would call this "up", and caching it would poison the
  // shell cache for good. Document route: deep link straight to the app root.
  await stack.setMode('down200');
  await page.goto(`${stack.base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-connection-status]', { timeout: 30000 });
  await waitForConnection(page, 'no-server');
  check('200 + HTML error page: still treated as unreachable', true);
  check(
    '200 + HTML error page: never shown as the app',
    !(await page.content()).includes('502: Bad gateway'),
  );
  check('200 + HTML error page: villager list still renders', (await page.locator(LIST).count()) > 0);
  check('200 + HTML error page: shell cache not poisoned', await shellCached(page));

  // --- Server returns ------------------------------------------------------
  await stack.setMode('up');
  await waitForConnection(page, 'connected', 40000);
  check('server back: header returns to "connected"', true);

  await page.waitForFunction(
    () => document.querySelector('[data-save-network]')?.getAttribute('data-save-network') === 'synced',
    undefined,
    { timeout: 30000 },
  );
  check('server back: deferred edit synced automatically', true);
  const uploaded = (stack.origin.lastPut ?? Buffer.from('')).toString('latin1');
  check('server back: upload reached the server', uploaded.includes('Ace'), `puts=${stack.origin.puts}`);

  // Shell cache is still the app, not a proxy page, after all of that.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(LIST, { timeout: 30000 });
  check('after recovery: app loads normally', (await page.locator('text=Ace').count()) > 0);

  LOG(failures.length ? `FAILED: ${failures.join('; ')}` : 'DONE — all checks passed');
} catch (e) {
  LOG('ERROR:', e.message);
  try {
    await page.screenshot({ path: 'origin-down-error.png' });
  } catch {}
  failures.push('exception');
} finally {
  await browser.close();
  stack.close();
}

process.exit(failures.length ? 1 : 0);
