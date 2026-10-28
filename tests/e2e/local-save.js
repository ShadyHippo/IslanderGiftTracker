// Local-save guarantees: what the device does with the gift log when the server
// is gone.
//
// Written for one specific regression that shipped and stayed invisible: the
// gift log wrote to IndexedDB through its own `indexedDB.open('acnh', 2)` while
// the shared app database was at version 3. Every single write failed with a
// VersionError, the error was swallowed, and the floppy badge still said
// "Saved on this device" — so offline edits only ever lived in memory. Closing
// the app (or a reload) lost them, silently.
//
// Nothing about that failure was visible without opening devtools. So this test
// asserts the contract instead of the implementation:
//
//   1. exactly one module owns the IndexedDB schema (static scan — a second
//      opener with its own pinned version is what broke it)
//   2. the stores the app uses all exist once it has booted
//   3. a real edit is written to IndexedDB immediately: right store, unsynced
//      flag set, real sqlite bytes containing the edit
//   4. it is still there after a reload with the origin down
//   5. a second edit updates the stored copy (no silent no-op after the first)
//   6. a confirmed server sync clears the unsynced flag
//   7. when storage refuses the write, the badge does NOT claim it saved
//
//   node local-save.js             (from tests/e2e, after `make client-build`)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  E2E_DIR,
  badges,
  checker,
  log,
  login,
  markFirstGift,
  readProgressRecord,
  readSchema,
  SRC,
  startStack,
  waitForConnection,
} from './lib/harness.js';

const LOG = log('local-save');
const { check, failures } = checker(LOG);

// --- 1. Static: one schema owner, no pinned versions ------------------------
const SCAN_EXTS = /\.(ts|js|mjs|cjs|svelte)$/;
const REL = (p) => path.relative(path.dirname(E2E_DIR), p);

/** Every IndexedDB open that hardcodes a version for the shared app db. */
const PINNED_VERSION = /indexedDB\s*\.\s*open\s*\(\s*(['"])acnh\1\s*,\s*\d+/;
/** Any direct open of the shared app db from app code. */
const ANY_OPEN = /indexedDB\s*\.\s*open\s*\(/;

/** Comments are prose; only real code counts. */
const isComment = (line) => /^\s*(\/\/|\/\*|\*|<!--)/.test(line);

function scanSources() {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!SCAN_EXTS.test(entry.name)) continue;
      const rel = REL(abs);
      // App code may only reach the db through openIdb(). Test code is allowed
      // to open it directly (it has to inspect what the app wrote), but a
      // pinned version is wrong everywhere: it silently goes stale.
      const inAppSource = abs.startsWith(SRC + path.sep);
      const isOwner = abs === path.join(SRC, 'lib/refdb.svelte.ts');
      fs.readFileSync(abs, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          if (PINNED_VERSION.test(line)) {
            offenders.push(`${rel}:${i + 1} pins a version for the shared acnh db`);
          }
          if (inAppSource && !isOwner && ANY_OPEN.test(line)) {
            offenders.push(`${rel}:${i + 1} opens the acnh db instead of importing openIdb`);
          }
        });
    }
  };
  walk(SRC);
  walk(E2E_DIR);
  return offenders;
}

const offenders = scanSources();
check('static: single IndexedDB schema owner, no pinned versions', offenders.length === 0, offenders.join(' | '));

// --- Runtime ----------------------------------------------------------------
const stack = await startStack();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem('aboutDismissed', '1'));

/** Poll the stored record until `pred` holds (writes are async). */
async function waitForRecord(pred, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await readProgressRecord(page);
    if (pred(last)) return last;
    await page.waitForTimeout(100);
  }
  return last;
}

const countAce = (rec) => (rec?.text?.match(/Ace/g) ?? []).length;

try {
  await login(page, stack.base);

  // --- 2. The stores the app needs exist and are the ones it opened ---------
  const schema = await readSchema(page);
  const required = ['refdb', 'progress', 'imgcache', 'imgs'];
  const missing = required.filter((s) => !schema.stores.includes(s));
  check(
    'schema: every store the app uses exists',
    missing.length === 0,
    `v${schema.version} [${schema.stores.join(', ')}]${missing.length ? ` missing ${missing.join(', ')}` : ''}`,
  );

  // Baseline: signing in pulls the db from the server and caches it in sync.
  const baseline = await waitForRecord((r) => r?.exists === true);
  check('baseline: progress db cached on the device after sign-in', baseline?.exists === true);
  check('baseline: cached copy starts out in sync', baseline?.unsynced === false, JSON.stringify({ unsynced: baseline?.unsynced }));

  // --- 3. A real edit is written to the device ------------------------------
  await stack.setMode('down');
  await page.click('text=Ace');
  await markFirstGift(page);

  const afterEdit = await waitForRecord((r) => r?.exists === true && r.unsynced === true && countAce(r) >= 1);
  check('edit: written to IndexedDB', afterEdit?.exists === true);
  check('edit: marked unsynced (server has not confirmed)', afterEdit?.unsynced === true);
  check(
    'edit: bytes are a real sqlite file containing the edit',
    afterEdit?.head?.startsWith('SQLite format 3') === true && countAce(afterEdit) >= 1,
    `head=${JSON.stringify(afterEdit?.head)} ace=${countAce(afterEdit)}`,
  );
  check('edit: nothing reached the server', stack.origin.puts === 0, `puts=${stack.origin.puts}`);

  const editBadges = await badges(page);
  check('edit: badge says saved on this device', editBadges.local === 'saved', JSON.stringify(editBadges));
  check('edit: sync badge stays pending', editBadges.network === 'pending');

  // The one optimistic upload attempt is what teaches the app the origin is
  // gone; the header must flip to "server unreachable" without a reload.
  await waitForConnection(page, 'no-server', 15000);
  check('edit: outage detected from the failed sync', true);

  // --- 4. Survives a reload with the origin still down ----------------------
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  check(
    'reload: edit is still marked after a reload',
    (await page.locator('button[aria-label="Already gifted — undo"]').count()) > 0,
  );
  const afterReload = await waitForRecord((r) => r?.exists === true);
  check('reload: stored copy still marked unsynced', afterReload?.unsynced === true);
  check('reload: stored copy still contains the edit', countAce(afterReload) >= 1);

  // --- 5. A second edit updates the stored copy -----------------------------
  // With the outage known, the app must not keep firing uploads it knows will
  // fail — the local write is the whole contract until the server returns.
  const attemptsBefore = stack.proxy.putAttempts;
  await markFirstGift(page); // same villager, a different item
  const afterSecond = await waitForRecord((r) => r?.exists === true && countAce(r) >= 2);
  check(
    'second edit: both gifts are in the stored db',
    countAce(afterSecond) >= 2,
    `ace rows=${countAce(afterSecond)} bytes=${afterSecond?.length}`,
  );
  await page.waitForTimeout(2500);
  check(
    'second edit: no doomed upload attempts while the server is down',
    stack.proxy.putAttempts === attemptsBefore,
    `attempts ${attemptsBefore} → ${stack.proxy.putAttempts}`,
  );

  // --- 6. A confirmed server sync clears the flag ---------------------------
  await stack.setMode('up');
  const synced = await waitForRecord((r) => r?.exists === true && r.unsynced === false, 30000);
  check('sync: unsynced flag cleared once the server confirmed', synced?.unsynced === false);
  check('sync: upload reached the server', stack.origin.puts >= 1, `puts=${stack.origin.puts}`);

  // --- 7. Storage failure must never look like success ---------------------
  // Same app, but every write to the progress store is rejected.
  const brokenContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const broken = await brokenContext.newPage();
  await broken.addInitScript(() => {
    localStorage.setItem('aboutDismissed', '1');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'progress') throw new DOMException('storage is full', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await login(broken, stack.base);
  await broken.click('text=Ace');
  await markFirstGift(broken);
  await broken.waitForTimeout(3000);

  const brokenBadges = await badges(broken);
  check(
    'storage failure: badge does not claim a local save',
    brokenBadges.local !== 'saved',
    JSON.stringify(brokenBadges),
  );
  check(
    'storage failure: the user is told the change is only in memory',
    (await broken.locator('text=only in memory').count()) > 0,
  );
  await brokenContext.close();

  LOG(failures.length ? `FAILED: ${failures.join('; ')}` : 'DONE — all checks passed');
} catch (e) {
  LOG('ERROR:', e.message);
  try {
    await page.screenshot({ path: 'local-save-error.png' });
  } catch {}
  failures.push('exception');
} finally {
  await browser.close();
  stack.close();
}

process.exit(failures.length ? 1 : 0);
