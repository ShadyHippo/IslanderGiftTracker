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

  // Gift ideas section renders with matched items
  await page.waitForSelector('section:has-text("Gift ideas")', { timeout: 5000 });
  const giftSection = await page.textContent('section:has-text("Gift ideas")');
  const perfectMatches = (giftSection?.match(/Perfect match/g) || []).length;
  const ideas = (giftSection?.match(/♥/g) || []).length;
  console.log(`gift ideas: ${ideas} color matches, ${perfectMatches} perfect matches`);
  if (!perfectMatches || !ideas) {
    console.error('FAIL: gift ideas section empty or no matches');
    process.exit(1);
  }
  console.log('PASS: gift ideas render with color/style matches');

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
