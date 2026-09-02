// UI smoke test — runs INSIDE mcr.microsoft.com/playwright:v1.62.1-noble.
// Usage: E2E_URL=http://localhost:8080 E2E_USER=testuser E2E_PASS=testpass node ui-smoke.js
import { chromium } from 'playwright';

const base = process.env.E2E_URL || 'http://localhost:8080';
const user = process.env.E2E_USER || 'testuser';
const pass = process.env.E2E_PASS || 'testpass';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-ish

// Autosave status: two round badges — local must be 'saved' and network
// 'synced' once the debounced upload completes.
const waitSaved = () =>
  page.waitForFunction(
    () =>
      document.querySelector('[data-save-local]')?.getAttribute('data-save-local') === 'saved' &&
      document.querySelector('[data-save-network]')?.getAttribute('data-save-network') === 'synced',
    null,
    { timeout: 15000 },
  );

try {
  const resp = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!resp || resp.status() !== 200) {
    console.error(`FAIL: page returned ${resp?.status()}`);
    process.exit(1);
  }

  // First visit: the About popup must appear and gate use until dismissed
  await page.waitForSelector('[data-about-modal]', { timeout: 10000 });
  const aboutText = (await page.textContent('[data-about-modal]')) || '';
  if (!aboutText.includes('ONE DEVICE IF OFFLINE')) {
    console.error('FAIL: About popup missing the one-device warning');
    process.exit(1);
  }
  if (!(await page.locator('[data-about-modal] a:has-text("Buy me a coffee")').count())) {
    console.error('FAIL: About popup missing Buy me a coffee button');
    process.exit(1);
  }
  const bmcHref = await page.getAttribute('[data-about-modal] a:has-text("Buy me a coffee")', 'href');
  if (!bmcHref || !bmcHref.startsWith('https://buymeacoffee.com/')) {
    console.error(`FAIL: coffee button href unexpected: ${bmcHref}`);
    process.exit(1);
  }
  await page.click('[data-about-close]');
  await page.waitForSelector('[data-about-modal]', { state: 'detached', timeout: 5000 });
  console.log('PASS: first-visit About popup shown and dismissed');

  // One-time offline install (login-page button): accept it when offered
  try {
    const btn = page.locator('button:has-text("Install offline data")');
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    console.log('install offered, accepting…');
    await btn.click();
    await page.waitForSelector('text=Offline data installed', { timeout: 300000 });
  } catch {
    console.log('no install offer (already installed or server unreachable)');
  }
  await page.waitForSelector('input[name=username]', { timeout: 30000 });

  // Login
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pass);
  await page.click('button[type=submit]');

  // Reference db download + villager list
  await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 30000 });
  await page.waitForSelector('text=Ace', { timeout: 30000 });
  const count = await page.textContent('header p');
  console.log('villager count line:', count?.trim());

  // Villager icons render (from IndexedDB via blob: URLs, not /img/ — images
  // no longer go through the service worker / Cache Storage)
  await page.waitForSelector('li img', { timeout: 10000 });
  const imgSrc = await page.getAttribute('li img', 'src');
  console.log('first villager img src:', imgSrc?.slice(0, 40));
  if (!imgSrc || !imgSrc.startsWith('blob:')) {
    console.error('FAIL: villager icons not rendering (expected blob: URLs from IndexedDB)');
    process.exit(1);
  }
  console.log('PASS: villager icons render (blob: from IndexedDB)');

  // About popup: clicking the dimmed background closes it, and the click
  // must NOT pass through to the controls behind it. (A touch-synthesized
  // click after the backdrop is removed mid-gesture would toggle a row's
  // favorite/island state or navigate — snapshot everything, nothing may
  // change.)
  const snapshotToggles = () =>
    page.$$eval('button[aria-label^="Toggle"]', (els) =>
      els.map((e) => `${e.getAttribute('aria-label')}:${e.getAttribute('aria-pressed')}`).sort().join('|'),
    );
  await page.locator('header button:has-text("About")').click();
  await page.waitForSelector('[data-about-modal]', { timeout: 5000 });
  const modalBox = await page.locator('[data-about-modal]').boundingBox();
  const togglesBefore = await snapshotToggles();
  const urlBefore = page.url();
  // A point above the dialog, over the list, on the dimmed backdrop.
  const x = 10;
  const y = Math.max(80, (modalBox?.top ?? 200) - 30);
  await page.mouse.click(x, y);
  await page.waitForSelector('[data-about-modal]', { state: 'detached', timeout: 5000 });
  const togglesAfter = await snapshotToggles();
  if (togglesAfter !== togglesBefore || page.url() !== urlBefore) {
    console.error('FAIL: outside click on About leaked onto the list behind it');
    process.exit(1);
  }
  console.log('PASS: About closes on outside click, nothing behind it was clicked');

  // Villager flags: favorite + on-island toggles, list filters, and the filters
  // clear the search text (so the narrowed list is immediately visible)
  const favBtn = page.locator('button[aria-label="Toggle favorite for Ace"]');
  const islandBtn = page.locator('button[aria-label="Toggle on-island for Ace"]');
  const favBefore = (await favBtn.getAttribute('aria-pressed')) === 'true';
  const islandBefore = (await islandBtn.getAttribute('aria-pressed')) === 'true';

  // Favorite Ace -> Favorites filter narrows the list
  await page.fill('input[placeholder^="Search by name"]', '');
  await page.waitForTimeout(200);
  await favBtn.click();
  await page.waitForFunction(
    () =>
      document.querySelector('button[aria-label="Toggle favorite for Ace"]')?.getAttribute('aria-pressed') === 'true',
    null,
    { timeout: 5000 },
  );
  await page.click('button:has-text("Favorites")');
  await page.waitForTimeout(200);
  const favRows = await page.locator('ul li').allTextContents();
  if (favRows.length === 0 || !favRows.some((t) => t.includes('Ace'))) {
    console.error(`FAIL: Favorites filter should include Ace, got ${favRows.length} rows`);
    process.exit(1);
  }
  await page.click('button:has-text("Favorites")');
  await page.waitForTimeout(200);

  // On-island Ace -> same filter for islanders
  await islandBtn.click();
  await page.waitForFunction(
    () =>
      document.querySelector('button[aria-label="Toggle on-island for Ace"]')?.getAttribute('aria-pressed') === 'true',
    null,
    { timeout: 5000 },
  );
  await page.click('button:has-text("On my island")');
  await page.waitForTimeout(200);
  const islandRows = await page.locator('ul li').allTextContents();
  if (islandRows.length === 0 || !islandRows.some((t) => t.includes('Ace'))) {
    console.error(`FAIL: On my island filter should include Ace, got ${islandRows.length} rows`);
    process.exit(1);
  }
  await page.click('button:has-text("On my island")');
  await page.waitForTimeout(200);

  // Restore original flag state; autosave uploads it (and cleans up the row)
  if (!favBefore) await favBtn.click();
  if (!islandBefore) await islandBtn.click();
  await waitSaved();
  console.log('PASS: villager favorite + on-island toggles and filters');

  // Search narrows the list
  await page.fill('input[placeholder^="Search by name"]', 'ankha');
  await page.waitForSelector('text=Ankha', { timeout: 5000 });
  await page.waitForSelector('text=Ace', { state: 'detached', timeout: 5000 });
  console.log('PASS: login -> reference db -> villager list -> search filter');

  // Open the detail (about) page — URL must change (deep-linkable)
  await page.click('text=Ankha');
  await page.waitForSelector('text=Likes', { timeout: 5000 });
  await page.waitForURL(/\/villager\/ankha$/i, { timeout: 5000 });
  console.log('URL after click:', page.url());
  const likes = await page.textContent('section:has-text("Likes")');
  console.log('likes section:', likes?.replace(/\s+/g, ' ').trim().slice(0, 140));
  await page.screenshot({ path: '/e2e/detail.png', fullPage: false });
  console.log('PASS: villager detail page renders at a deep-linkable URL');

  // Gift ideas: collapsible groups with counts
  await page.waitForSelector('section:has-text("Gift ideas")', { timeout: 5000 });
  const groupSummaries = await page.$$eval('summary', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  console.log('group summaries:', groupSummaries.slice(0, 4));
  const hasFurniture = groupSummaries.some((s) => s.includes('Furniture'));
  const hasClothing = groupSummaries.some((s) => s.includes('Clothing'));
  if (!hasFurniture || !hasClothing) {
    console.error('FAIL: expected Furniture + Clothing groups');
    process.exit(1);
  }
  console.log('PASS: gift groups render with counts');

  // Expand Furniture -> items render with thumbnails (all items are perfect)
  await page.click('section:has-text("Gift ideas") summary:has-text("Furniture")');
  await page.waitForSelector('li img', { timeout: 10000 });
  const furnitureRows = await page.locator('section:has-text("Gift ideas") details:has(summary:has-text("Furniture")) li').count();
  if (!furnitureRows) {
    console.error('FAIL: no items in expanded Furniture group');
    process.exit(1);
  }
  console.log(`PASS: Furniture group expands (${furnitureRows} items, thumbnails render)`);

  // Gift ideas search: matches names across the group, restores when cleared
  const furn = page.locator('section:has-text("Gift ideas") details:has(summary:has-text("Furniture"))');
  const full = await furn.locator('li').count();
  const firstItemName = (((await furn.locator('li p.font-medium').first().textContent()) ?? '').trim().split(' (')[0]).trim();
  if (!firstItemName) {
    console.error('FAIL: could not read the first furniture item name');
    process.exit(1);
  }
  const giftSearch = page.locator('input[placeholder^="Search gifts"]');
  await giftSearch.fill(firstItemName);
  await page.waitForTimeout(300);
  const searchRows = await furn.locator('li').allTextContents();
  if (searchRows.length === 0 || searchRows.some((t) => !t.includes(firstItemName))) {
    console.error(`FAIL: gift search shows non-matching rows or nothing for "${firstItemName}"`);
    process.exit(1);
  }
  await giftSearch.fill('');
  await page.waitForTimeout(300);
  if ((await furn.locator('li').count()) !== full) {
    console.error('FAIL: clearing gift search did not restore rows');
    process.exit(1);
  }
  console.log(`PASS: gift search filters by name (${firstItemName}: ${searchRows.length} rows)`);

  // Gift log: toggle a gift, autosave uploads it, history is searchable, undo
  const giftedSel = 'button[aria-label="Mark as gifted"], button[aria-label="Already gifted — undo"]';
  await page.waitForSelector(giftedSel, { timeout: 10000 });
  const giftToggle = page.locator(giftedSel).first();
  const before = (await giftToggle.getAttribute('aria-label')) === 'Already gifted — undo';
  await giftToggle.click();
  await page.waitForFunction(
    (wasGifted) => {
      const el = document.querySelector('[aria-label="Mark as gifted"], [aria-label="Already gifted — undo"]');
      return el !== null && (el.getAttribute('aria-label') === 'Already gifted — undo') !== wasGifted;
    },
    before,
    { timeout: 5000 },
  );

  // Gift log: toggle + autosave persists it; undo leaves no residue
  await waitSaved();
  console.log('PASS: gift toggle + autosave');

  // Undo -> marker flips back; autosave leaves no residue
  await giftToggle.click();
  await page.waitForFunction(
    (wasGifted) => {
      const el = document.querySelector('[aria-label="Mark as gifted"], [aria-label="Already gifted — undo"]');
      return el !== null && (el.getAttribute('aria-label') === 'Already gifted — undo') === wasGifted;
    },
    before,
    { timeout: 5000 },
  );
  await waitSaved();
  console.log('PASS: gift log round-trips (undo + autosave)');

  // Their house: interior/exterior photos, exact-color items, and Buy: lines.
  // Images are lazy (IntersectionObserver): scroll the section into view to
  // trigger resolution, then expect blob: URLs from IndexedDB.
  const houseSection = page.locator('section:has-text("Their house")');
  await houseSection.scrollIntoViewIfNeeded();
  await houseSection.waitFor({
    state: 'attached',
    timeout: 5000,
  });
  await page.waitForSelector('section:has-text("Their house") img[alt^="Inside"]', { timeout: 15000 });
  await page.waitForSelector('section:has-text("Their house") img[alt^="Outside"]', { timeout: 5000 });
  const housePhotoSrc = await page.getAttribute('section:has-text("Their house") img[alt^="Inside"]', 'src');
  if (!housePhotoSrc || !housePhotoSrc.startsWith('blob:')) {
    console.error(`FAIL: house photo should be a blob: URL from IndexedDB, got ${housePhotoSrc?.slice(0, 40)}`);
    process.exit(1);
  }
  const houseItems = await page.locator('section:has-text("Their house") li').count();
  if (houseItems === 0) {
    console.error('FAIL: no house items rendered');
    process.exit(1);
  }
  // Every house item must carry an exact image path (the data pipeline check);
  // each LazyImage exposes it via data-path on the wrapper span.
  const houseThumbs = await page.locator('section:has-text("Their house") li span[data-path^="/img/"]').count();
  if (houseThumbs !== houseItems) {
    console.error(`FAIL: all ${houseItems} house items should have exact thumbnails, got ${houseThumbs}`);
    process.exit(1);
  }
  const buyLine = await page.locator('p:has-text("Buy:")').count();
  if (buyLine === 0) {
    console.error('FAIL: gift cards should show a Buy: line (source)');
    process.exit(1);
  }
  console.log(`PASS: house photos + ${houseItems} house items + Buy: line`);

  // Browser back button returns to the list
  await page.goBack();
  await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 5000 });
  console.log('PASS: browser back returns to the list');

  // Deep link: load /villager/Ankha directly (server must SPA-fallback)
  await page.goto(`${base}/villager/Ankha`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('text=Likes', { timeout: 30000 });
  console.log('PASS: direct deep link /villager/Ankha renders');

  // Deep link with a space in the name (URL-encoded)
  await page.goto(`${base}/villager/Agent%20S`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('text=Agent S', { timeout: 30000 });
  console.log('PASS: deep link with encoded space (Agent S) renders');

  // A plain refresh must reuse the IndexedDB-cached reference db — the only
  // network requests for /db/reference* happen when the cache is (wrongly)
  // invalidated. Counts actual requests so it cannot race past a quick
  // localhost download.
  let dbRequests = 0;
  page.on('request', (req) => {
    if (req.url().includes('/db/reference')) dbRequests++;
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('text=Agent S', { timeout: 30000 });
  await page.waitForTimeout(3000);
  if (dbRequests > 0) {
    console.error(`FAIL: a plain refresh re-downloaded the reference db (${dbRequests} request(s))`);
    process.exit(1);
  }
  console.log('PASS: refresh reuses the cached reference db (no re-download)');

  // About popup must stay dismissed for the rest of the session/device
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  if (await page.locator('[data-about-modal]').count()) {
    console.error('FAIL: About popup reappeared after dismissal');
    process.exit(1);
  }
  console.log('PASS: About popup stays dismissed on reload');

  // Theme switch: defaults to the OS theme (light here) → moon icon; clicking
  // flips to dark with a sun icon, persists '@theme' in localStorage, and the
  // choice survives a reload.
  const lightToggle = page.locator('button[aria-label="Switch to dark theme"]');
  await lightToggle.waitFor({ state: 'visible', timeout: 5000 });
  if ((await lightToggle.locator('svg circle').count()) !== 0) {
    console.error('FAIL: light mode should show a moon icon (no sun circle)');
    process.exit(1);
  }
  await lightToggle.click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 5000 });
  const darkToggle = page.locator('button[aria-label="Switch to light theme"]');
  await darkToggle.waitFor({ state: 'visible', timeout: 5000 });
  if ((await darkToggle.locator('svg circle').count()) !== 1) {
    console.error('FAIL: dark mode should show a sun icon (sun circle)');
    process.exit(1);
  }
  const storedTheme = await page.evaluate(() => localStorage.getItem('@theme'));
  if (storedTheme !== 'dark') {
    console.error(`FAIL: expected localStorage @theme=dark, got ${storedTheme}`);
    process.exit(1);
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 30000 });
  if (!(await page.evaluate(() => document.documentElement.classList.contains('dark')))) {
    console.error('FAIL: dark choice lost on reload');
    process.exit(1);
  }
  await page.locator('button[aria-label="Switch to light theme"]').waitFor({ state: 'visible', timeout: 5000 });
  console.log('PASS: theme switch moon<->sun + persisted in localStorage');

  await page.screenshot({ path: '/e2e/smoke.png', fullPage: false });
  console.log('screenshot -> tests/e2e/smoke.png');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
} finally {
  await browser.close();
}
