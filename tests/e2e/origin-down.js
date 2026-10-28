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
  readProgressRecord,
  startStack,
  waitForConnection,
} from './lib/harness.js';

const LOG = log('origin-down');
const { check, failures } = checker(LOG);

/** Poll a page's stored gift-log record until `pred` holds. */
async function waitForRecordOn(target, pred, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await readProgressRecord(target);
    if (pred(last)) return last;
    await target.waitForTimeout(100);
  }
  return last;
}

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
  check(
    'server back: the waiting note is gone',
    (await page.locator('[data-sync-waiting]').count()) === 0,
  );
  const uploaded = (stack.origin.lastPut ?? Buffer.from('')).toString('latin1');
  check('server back: upload reached the server', uploaded.includes('Ace'), `puts=${stack.origin.puts}`);

  // Shell cache is still the app, not a proxy page, after all of that.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(LIST, { timeout: 30000 });
  check('after recovery: app loads normally', (await page.locator('text=Ace').count()) > 0);

  // --- No bars at all, then the network returns -----------------------------
  // The realistic phone case, and the one this suite originally missed: the
  // device reports no link, so the app never sends a request, never observes a
  // "server down" transition, and there is nothing to edge-trigger on. Coming
  // back online has to push those edits by itself, with no extra tap and no
  // reload. Reported from real use: "it only synced when I saved something new".
  //
  // Two variants, because phones differ: (A) the offline event arrives but the
  // matching online event is missed (common on iOS), (B) the app is closed while
  // offline and reopened after the server is back.
  const reconnect = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const rpage = await reconnect.newPage();
  await rpage.addInitScript(() => {
    localStorage.setItem('aboutDismissed', '1');
    // Drive the link state the way the browser reports it. Going offline fires
    // the event; coming back deliberately does not, to model a missed 'online'.
    let up = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => up });
    window.__link = (next) => {
      up = next;
      if (!next) window.dispatchEvent(new Event('offline'));
    };
  });
  await login(rpage, stack.base);

  const putsBefore = stack.origin.puts;
  await stack.setMode('down');
  await rpage.evaluate(() => window.__link(false));
  await reconnect.setOffline(true);
  await rpage.waitForTimeout(1500);
  await rpage.click('text=Ace');
  await markFirstGift(rpage);

  const offlineRecord = await waitForRecordOn(rpage, (r) => r?.exists === true && r.unsynced === true);
  check('no network: edit is saved on the device', offlineRecord?.unsynced === true);

  // Wait past the autosave debounce (1.5s) and any in-flight attempt. Otherwise
  // a still-pending debounce fires after the network returns and quietly does
  // the sync itself, which is exactly how this bug hid from the first version of
  // this test.
  await rpage.waitForTimeout(4000);
  const stillPending = await badges(rpage);
  check('no network: still pending after the autosave window', stillPending.network === 'pending', JSON.stringify(stillPending));
  check(
    'no network: nothing reached the server',
    stack.origin.puts === putsBefore,
    `puts ${putsBefore} -> ${stack.origin.puts}`,
  );

  // Network and server come back. No taps, no reload, no new edit, and no
  // 'online' event: the app has to notice and push on its own.
  await stack.setMode('up');
  await reconnect.setOffline(false);
  // Link is back at the browser level, but the page was never told.
  await rpage.evaluate(() => window.__link(true));
  const cameBack = await rpage
    .waitForFunction(
      () => document.querySelector('[data-save-network]')?.getAttribute('data-save-network') === 'synced',
      undefined,
      { timeout: 45000 },
    )
    .then(() => true)
    .catch(() => false);
  check(
    'no network: unsynced edits upload on their own once it returns',
    cameBack && stack.origin.puts > putsBefore,
    `synced=${cameBack} puts ${putsBefore} -> ${stack.origin.puts}`,
  );

  // (B) closed while offline, reopened after the server is back.
  stack.resetProgress();
  const putsBeforeReopen = stack.origin.puts;
  await stack.setMode('down');
  await rpage.evaluate(() => window.__link(false));
  await reconnect.setOffline(true);
  await rpage.waitForTimeout(1200);
  await markFirstGift(rpage); // a second gift, unsynced
  await waitForRecordOn(rpage, (r) => r?.exists === true && r.unsynced === true);
  await rpage.close();

  await stack.setMode('up');
  await reconnect.setOffline(false);
  const reopened = await reconnect.newPage();
  await reopened.addInitScript(() => localStorage.setItem('aboutDismissed', '1'));
  await reopened.goto(stack.base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await reopened.waitForFunction(
    () => document.querySelector('[data-save-network]')?.getAttribute('data-save-network') === 'synced',
    undefined,
    { timeout: 45000 },
  );
  check(
    'reopened online: unsynced edits from the last session upload',
    stack.origin.puts > putsBeforeReopen,
    `puts ${putsBeforeReopen} -> ${stack.origin.puts}`,
  );
  // (C) The browser never fires online/offline at all (iOS does this). The only
  // way the app can notice is its own health-check ladder, which runs because
  // there are unsaved edits.
  const silent = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const spage = await silent.newPage();
  await spage.addInitScript(() => {
    localStorage.setItem('aboutDismissed', '1');
    const add = window.addEventListener.bind(window);
    window.addEventListener = (type, fn, opts) => {
      if (type === 'online' || type === 'offline') return; // never delivered
      return add(type, fn, opts);
    };
  });
  stack.resetProgress();
  await login(spage, stack.base);

  const putsBeforeSilent = stack.origin.puts;
  await stack.setMode('down');
  await silent.setOffline(true);
  await spage.waitForTimeout(1500); // let the offline state settle, as in (A)
  await spage.click('text=Ace');
  await markFirstGift(spage);
  await spage.waitForTimeout(4000); // let the attempt fail and arm the ladder
  check(
    'no events: edit waits on the device',
    (await badges(spage)).network === 'pending' && stack.origin.puts === putsBeforeSilent,
  );

  await stack.setMode('up');
  await silent.setOffline(false);
  const recoveredSilently = await spage
    .waitForFunction(
      () => document.querySelector('[data-save-network]')?.getAttribute('data-save-network') === 'synced',
      undefined,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false);
  check(
    'no events: health-check ladder uploads without any browser event',
    recoveredSilently && stack.origin.puts > putsBeforeSilent,
    `synced=${recoveredSilently} puts ${putsBeforeSilent} -> ${stack.origin.puts}`,
  );
  await silent.close();
  await reconnect.close();

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
