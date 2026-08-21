// Offline-everything check: after install, go offline and load a villager
// that was never visited — all images (icons + house photos) must come from cache.
import { chromium } from 'playwright';
const base = process.env.E2E_URL || 'http://localhost:18080';
const user = process.env.E2E_USER || 'hippo';
const pass = process.env.E2E_PASS || 'CHANGE_ME';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const LOG = (...a) => console.log('[img-all]', ...a);
// Returning-user path: About popup already dismissed on this device
await page.addInitScript(() => localStorage.setItem('aboutDismissed', '1'));

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
try {
  const btn = page.locator('button:has-text("Install offline data")');
  await btn.waitFor({ state: 'visible', timeout: 8000 });
  LOG('install offered, accepting…');
  await btn.click();
  await page.waitForSelector('text=Offline data installed', { timeout: 300000 });
} catch { LOG('no install offer (already installed)'); }
await page.waitForSelector('input[name=username]', { timeout: 30000 });
await page.fill('input[name=username]', user);
await page.fill('input[name=password]', pass);
await page.click('button[type=submit]');
await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 60000 });
await page.evaluate(async () => { await navigator.serviceWorker.ready; });
await page.waitForTimeout(1000);

// Spot-check a few cached URLs (keys() is too large to list in Chromium)
const spot = await page.evaluate(async () => {
  const c = await caches.open('acnh-img-v3');
  const probes = ['/img/villagers/marshal.webp', '/img/marshal/interior.webp', '/img/marshal/exterior.webp'];
  const out = {};
  for (const u of probes) out[u] = !!(await c.match(u));
  return out;
});
LOG('cache spot-check:', JSON.stringify(spot));

await context.setOffline(true);
LOG('--- offline ---');
// Cold start: reload the app first (like a PWA relaunch)
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => LOG('reload err', e.message));
await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 30000 });
LOG('offline list OK');
// Never-visited villager with a deep link
await page.goto(`${base}/villager/Marshal`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => LOG('nav err', e.message));
await page.waitForTimeout(8000);
const res = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')];
  const ok = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
  const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.slice(-50));
  return {
    total: imgs.length,
    ok,
    broken: broken.slice(0, 5),
    hasLikes: !!document.body.textContent.includes('Likes'),
    hasHouse: document.body.textContent.includes('Their house'),
  };
});
LOG('page renders:', JSON.stringify(res));
// Directly fetch a cross-section of the library through the SW while offline:
// portraits, house photos, item icons — every class of image must be cached.
const probe = await page.evaluate(async () => {
  const urls = [
    '/img/villagers/marshal.webp',
    '/img/marshal/interior.webp',
    '/img/marshal/exterior.webp',
    '/img/housewares/ranch_bed_green_blue_gingham.webp',
    '/img/ace/water_bird.webp',
    '/img/fish/sea_horse.webp',
  ];
  const out = {};
  for (const u of urls) {
    try {
      const r = await fetch(u);
      out[u.slice(5)] = `${r.status}/${(r.headers.get('Content-Type') || '').split('/')[1]}`;
    } catch { out[u.slice(5)] = 'ERR'; }
  }
  return out;
});
LOG('offline fetches:', JSON.stringify(probe));
const allOk = Object.values(probe).every((v) => v.startsWith('200/') && v.endsWith('webp'));
LOG(allOk && res.hasLikes && res.hasHouse && res.broken.length === 0 ? 'PASS' : 'FAIL');
await browser.close();
