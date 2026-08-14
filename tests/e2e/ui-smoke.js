// UI smoke test — runs INSIDE mcr.microsoft.com/playwright:v1.62.1-noble.
// Usage: E2E_URL=http://localhost:8080 E2E_USER=wife E2E_PASS=devpass node ui-smoke.js
import { chromium } from 'playwright';

const base = process.env.E2E_URL || 'http://localhost:8080';
const user = process.env.E2E_USER || 'wife';
const pass = process.env.E2E_PASS || 'devpass';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-ish

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

  // Expand Furniture -> items with perfect badges + thumbnails
  await page.click('summary:has-text("Furniture")');
  await page.waitForSelector('li img', { timeout: 10000 });
  const furnitureText = await page.textContent('details:has(summary:has-text("Furniture"))');
  const perfect = (furnitureText?.match(/Perfect match/g) || []).length;
  if (!perfect) {
    console.error('FAIL: no perfect matches in expanded Furniture group');
    process.exit(1);
  }
  console.log(`PASS: Furniture group expands (${perfect} perfect matches, thumbnails render)`);

  // Expand Clothing -> type filter pills -> filter to Headwear (multi-select)
  await page.click('summary:has-text("Clothing")');
  await page.waitForSelector('details:has(summary:has-text("Clothing")) button:has-text("Headwear")', { timeout: 5000 });
  await page.click('details:has(summary:has-text("Clothing")) button:has-text("Headwear")');
  await page.waitForTimeout(300);
  const headwearRows = await page.$$eval(
    'details:has(summary:has-text("Clothing")) li',
    (els) => els.map((e) => e.textContent?.trim() ?? ''),
  );
  console.log(`headwear filter: ${headwearRows.length} visible rows`);
  if (headwearRows.length === 0 || headwearRows.some((t) => !t.includes('Headwear'))) {
    console.error('FAIL: Headwear filter shows non-Headwear rows or nothing');
    process.exit(1);
  }
  console.log('PASS: clothing type filter works');

  // Furniture type pills: select filters, deselect restores, drill + breadcrumb
  const furn = page.locator('details:has(summary:has-text("Furniture"))');
  if ((await furn.locator('.type-pills').count()) === 0) {
    console.error('FAIL: Furniture type pills not rendered on expand');
    process.exit(1);
  }
  const rowCount = async () => furn.locator('li').count();
  const full = await rowCount();
  const firstMain = furn.locator('.pill-main').first();
  const pillText = ((await firstMain.textContent()) ?? '').trim();
  await firstMain.click();
  await page.waitForTimeout(300);
  const selected = await rowCount();
  if (selected > full) {
    console.error('FAIL: selecting a type pill increased the row count');
    process.exit(1);
  }
  await firstMain.click();
  await page.waitForTimeout(300);
  const restored = await rowCount();
  if (restored !== full) {
    console.error(`FAIL: deselecting did not restore rows (${restored} != ${full})`);
    process.exit(1);
  }
  console.log(`PASS: furniture type pills filter (${pillText}: ${full} -> ${selected} -> ${restored})`);

  // Drill into a type -> breadcrumb appears; All returns to root
  await firstMain.click();
  const drill = furn.locator('.pill-drill').first();
  if ((await drill.count()) > 0) {
    await drill.click();
    await page.waitForSelector('details:has(summary:has-text("Furniture")) .pill-crumbs', { timeout: 5000 });
    const crumbs = ((await furn.locator('.pill-crumbs').textContent()) ?? '').trim();
    if (!crumbs.startsWith('All')) {
      console.error(`FAIL: breadcrumb does not start with All (${crumbs})`);
      process.exit(1);
    }
    await furn.locator('.pill-crumbs button').first().click();
    await page.waitForTimeout(200);
    console.log(`PASS: furniture pill drill + breadcrumb (${crumbs})`);
  } else {
    console.log('SKIP: no furniture pill with children to drill into');
  }
  await firstMain.click(); // deselect back to full list

  // Buyable pill: AND filter, toggles back
  const buyableBtn = furn.locator('button:text-is("Buyable only")');
  await buyableBtn.click();
  await page.waitForTimeout(300);
  const buyableRows = await rowCount();
  if (buyableRows > full) {
    console.error('FAIL: Buyable filter increased rows');
    process.exit(1);
  }
  await buyableBtn.click();
  await page.waitForTimeout(300);
  if ((await rowCount()) !== full) {
    console.error('FAIL: Buyable off did not restore rows');
    process.exit(1);
  }
  console.log(`PASS: buyable pill filters (${full} -> ${buyableRows})`);

  // Irrelevant expander nests the rest (Surfaces, Music, ...)
  await page.click('summary:has-text("Irrelevant")');
  await page.waitForSelector('summary:has-text("Surfaces")', { timeout: 5000 });
  await page.click('summary:has-text("Surfaces")');
  await page.waitForSelector('details:has(summary:has-text("Surfaces")) li', { timeout: 5000 });
  const surfRows = await page.$$eval('details:has(summary:has-text("Surfaces")) li', (els) => els.length);
  console.log(`Irrelevant -> Surfaces: ${surfRows} rows`);
  if (!surfRows) {
    console.error('FAIL: Irrelevant expander did not reveal nested groups');
    process.exit(1);
  }
  console.log('PASS: Irrelevant expander nests the other groups');

  // Their house strip renders
  await page.waitForSelector('section:has-text("Their house")', { timeout: 5000 });
  console.log('PASS: house items render');

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
