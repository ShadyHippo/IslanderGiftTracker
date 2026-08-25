// Probe for the three UX fixes: detail-header action buttons, compact hero,
// filter persistence across back navigation.
const { chromium } = require('playwright');

(async () => {
  const base = process.env.BASE_URL || 'http://host.docker.internal:8080';
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });

  // login (password mode dev server)
  await page.waitForSelector('input[name="username"]', { timeout: 10000 });
  const about = page.locator('[data-about-close]');
  if (await about.count()) await about.click(); // first-visit popup gates the form
  await page.fill('input[name="username"]', 'testuser');
  await page.fill('input[name="password"]', 'testpass');
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[type="search"]', { timeout: 15000 });

  // --- 3) filter persistence: star a villager, enable Favorites, drill in
  await page.click('ul li button[aria-label^="Toggle favorite"]');
  await page.click('button:has-text("Favorites")');
  const pressed = await page.getAttribute('button:has-text("Favorites")', 'aria-pressed');
  console.log(pressed === 'true' ? 'PASS: favorites filter activates' : `FAIL: aria-pressed=${pressed}`);

  await page.click('ul li a'); // first (favorite) villager
  await page.waitForSelector('h2:has-text("About")', { timeout: 10000 });

  // --- 1) action buttons in the header, same look as list page
  const star = page.locator('header button[aria-label^="Toggle favorite"]');
  const check = page.locator('header button[aria-label^="Toggle on-island"]');
  const starBox = await star.boundingBox();
  const headerBox = await page.locator('header').boundingBox();
  const topRight = starBox && headerBox && starBox.y + starBox.height / 2 < headerBox.y + headerBox.height &&
    starBox.x + starBox.width > headerBox.x + headerBox.width * 0.6;
  console.log((await star.count()) === 1 && (await check.count()) === 1 && topRight
    ? 'PASS: favorite + on-island buttons in header top-right' : 'FAIL: header buttons missing/misplaced');

  // toggle favorite from detail, verify state + list parity after back
  const before = await star.getAttribute('aria-pressed');
  await star.click();
  const after = await star.getAttribute('aria-pressed');
  console.log(before !== after ? 'PASS: detail favorite toggles' : 'FAIL: toggle no-op');

  await page.click('button:has-text("Back")');
  await page.waitForSelector('button:has-text("Favorites")');
  const stillPressed = await page.getAttribute('button:has-text("Favorites")', 'aria-pressed');
  console.log(stillPressed === 'true' ? 'PASS: filter survives back navigation' : `FAIL: filter reset (${stillPressed})`);

  // --- 2) compact hero: avatar is 64px and hero card is short
  await page.click('button:has-text("Favorites")'); // clear filter (toggle un-starred it)
  await page.waitForSelector('ul li a', { timeout: 10000 });
  await page.click('ul li a');
  await page.waitForSelector('h2:has-text("About")', { timeout: 10000 });
  const hero = await page.locator('section').first().boundingBox();
  const aboutH2 = await page.locator('h2:has-text("About")').boundingBox();
  const shortHero = hero && hero.height < 100;
  const visible = aboutH2 && hero && aboutH2.y < hero.y + 700; // about card near hero on a phone-ish viewport
  console.log(shortHero ? `PASS: hero compact (${Math.round(hero.height)}px)` : `FAIL: hero still tall (${hero && Math.round(hero.height)}px)`);
  console.log(visible ? 'PASS: About section reachable without deep scroll' : 'FAIL: content still far below');
  await page.screenshot({ path: '/e2e/detail-compact.png' });

  await browser.close();
})();

// diagnostic: is Back SPA or full reload?
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const base = process.env.BASE_URL || 'http://host.docker.internal:8080';
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]');
  const ab = page.locator('[data-about-close]');
  if (await ab.count()) await ab.click();
  await page.fill('input[name="username"]', 'testuser');
  await page.fill('input[name="password"]', 'testpass');
  await page.click('button[type="submit"]');
  await page.waitForSelector('ul li a');
  await page.evaluate(() => { window.__spaMarker = 'alive'; });
  await page.click('ul li a');
  await page.waitForSelector('h2:has-text("About")');
  await page.evaluate(() => { window.__spaMarker = 'set-in-detail'; });
  await page.click('button:has-text("Back")');
  await page.waitForSelector('button:has-text("Favorites")');
  const m = await page.evaluate(() => window.__spaMarker);
  console.log('marker after back:', m, '=>', m === 'set-in-detail' ? 'SPA (module state should survive)' : 'FULL RELOAD (modules re-evaluated)');
  await browser.close();
})();
