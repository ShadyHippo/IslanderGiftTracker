// UI smoke test — runs INSIDE mcr.microsoft.com/playwright:v1.62.1-noble.
// Usage: E2E_URL=http://localhost:8080 E2E_USER=wife E2E_PASS=devpass node ui-smoke.js
import { chromium } from 'playwright';

const base = process.env.E2E_URL || 'http://localhost:8080';
const user = process.env.E2E_USER || 'wife';
const pass = process.env.E2E_PASS || 'devpass';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-ish

// Autosave status indicator (passive pill in App.svelte): 'Unsaved changes'
// while debouncing, then 'Saved hh:mm:ss' after the upload completes.
const waitDirty = () =>
  page.waitForFunction(
    () => document.querySelector('[data-save-status]')?.textContent?.trim() === 'Unsaved changes',
    null,
    { timeout: 5000 },
  );
const waitSaved = () =>
  page.waitForFunction(
    () => document.querySelector('[data-save-status]')?.textContent?.trim().startsWith('Saved '),
    null,
    { timeout: 15000 },
  );

try {
  const resp = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!resp || resp.status() !== 200) {
    console.error(`FAIL: page returned ${resp?.status()}`);
    process.exit(1);
  }

  // Login
  await page.waitForSelector('input[name=username]', { timeout: 15000 });
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pass);
  await page.click('button[type=submit]');

  // Reference db download + villager list
  await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 30000 });
  await page.waitForSelector('text=Ace', { timeout: 30000 });
  const count = await page.textContent('header p');
  console.log('villager count line:', count?.trim());

  // Villager icons render (not initials fallback)
  await page.waitForSelector('li img', { timeout: 10000 });
  const imgSrc = await page.getAttribute('li img', 'src');
  console.log('first villager img src:', imgSrc?.slice(0, 40));
  if (!imgSrc || !imgSrc.startsWith('blob:')) {
    console.error('FAIL: villager icons not rendering (expected blob: URLs)');
    process.exit(1);
  }
  console.log('PASS: villager icons render');

  // Villager flags: favorite + on-island toggles, list filters, and the filters
  // clear the search text (so the narrowed list is immediately visible)
  const favBtn = page.locator('button[aria-label="Toggle favorite for Ace"]');
  const islandBtn = page.locator('button[aria-label="Toggle on-island for Ace"]');
  const favBefore = (await favBtn.getAttribute('aria-pressed')) === 'true';
  const islandBefore = (await islandBtn.getAttribute('aria-pressed')) === 'true';

  // Favorite Ace -> Favorites filter narrows the list AND clears the search
  await page.fill('input[placeholder^="Search by name"]', 'ace');
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
  const searchAfterFilter = await page.inputValue('input[placeholder^="Search by name"]');
  if (searchAfterFilter !== '') {
    console.error(`FAIL: toggling a filter should clear the search text, got "${searchAfterFilter}"`);
    process.exit(1);
  }
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
  console.log('PASS: villager favorite + on-island toggles, filters, and search-clear');

  // Search narrows the list
  await page.fill('input[placeholder^="Search by name"]', 'ankha');
  await page.waitForSelector('text=Ankha', { timeout: 5000 });
  await page.waitForSelector('text=Ace', { state: 'detached', timeout: 5000 });
  console.log('PASS: login -> reference db -> villager list -> search filter');

  // Open the detail (about) page — URL must change (deep-linkable)
  await page.click('text=Ankha');
  await page.waitForSelector('text=Likes', { timeout: 5000 });
  await page.waitForURL('**/villager/Ankha', { timeout: 5000 });
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
  await page.click('summary:has-text("Furniture")');
  await page.waitForSelector('li img', { timeout: 10000 });
  const furnitureRows = await page.locator('details:has(summary:has-text("Furniture")) li').count();
  if (!furnitureRows) {
    console.error('FAIL: no items in expanded Furniture group');
    process.exit(1);
  }
  console.log(`PASS: Furniture group expands (${furnitureRows} items, thumbnails render)`);

  // Gift ideas search: matches names across the group, restores when cleared
  const furn = page.locator('details:has(summary:has-text("Furniture"))');
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

  // Their house: interior/exterior photos, exact-color items, and Buy: lines
  await page.waitForSelector('section:has-text("Their house") img[alt^="Inside"]', { timeout: 15000 });
  await page.waitForSelector('section:has-text("Their house") img[alt^="Outside"]', { timeout: 5000 });
  const houseItems = await page.locator('section:has-text("Their house") li').count();
  if (houseItems === 0) {
    console.error('FAIL: no house items rendered');
    process.exit(1);
  }
  const houseThumbs = await page.locator('section:has-text("Their house") li img[src^="blob:"]').count();
  if (houseThumbs !== houseItems) {
    console.error(`FAIL: all ${houseItems} house items should render exact thumbnails, got ${houseThumbs}`);
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

  await page.screenshot({ path: '/e2e/smoke.png', fullPage: false });
  console.log('screenshot -> tests/e2e/smoke.png');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
} finally {
  await browser.close();
}
