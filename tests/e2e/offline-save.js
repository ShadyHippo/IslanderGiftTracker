// Offline save reproduction test — persistent context, assets pre-cached.
import { chromium } from 'playwright';
const base = process.env.E2E_URL || 'http://localhost:8080';
const user = process.env.E2E_USER || 'wife';
const pass = process.env.E2E_PASS || 'devpass';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const LOG = (...a) => console.log('[offline]', ...a);

async function login() {
  if (await page.locator('input[name=username]').count()) {
    await page.fill('input[name=username]', user);
    await page.fill('input[name=password]', pass);
    await page.click('button[type=submit]');
  }
  await page.waitForSelector('input[placeholder^="Search by name"]', { timeout: 30000 });
  await page.waitForSelector('text=Ace', { timeout: 30000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForTimeout(1500);
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // One-time install prompt (db + image bundle download): accept it so every
  // image lands in Cache Storage and the offline checks below can pass.
  try {
    const dl = page.locator('button:has-text("Download")');
    await dl.waitFor({ state: 'visible', timeout: 8000 });
    LOG('install prompt shown, accepting…');
    await dl.click();
  } catch {
    LOG('no install prompt (already installed)');
  }
  // Install extracts ~20k images; give it plenty of time before login appears.
  await page.waitForSelector('input[name=username]', { timeout: 300000 });
  await login();
  LOG('load1 online loaded');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await login();
  LOG('load2 online loaded (assets cached)');

  await context.setOffline(true);
  LOG('--- offline ---');

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => LOG('offload1 err', e.message));
  await page.waitForTimeout(3000);
  LOG('offline load1 OK?', (await page.locator('input[placeholder^="Search by name"]').count()) > 0);

  if (await page.locator('input[placeholder^="Search by name"]').count()) {
    await page.click('text=Ace');
    await page.waitForTimeout(1500);
    if (await page.locator('details summary').count()) await page.locator('details summary').first().click();
    await page.waitForTimeout(500);
    const btn = page.locator('button[aria-label="Mark as gifted"]').first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2500);
      LOG('pill after offline edit:', (await page.locator('[data-save-status]').textContent())?.trim());
    }
    // inspect IndexedDB progress store NOW
    const idb = await page.evaluate(async () => {
      try {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('acnh', 2);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const tx = db.transaction('progress', 'readonly');
        return await new Promise((res) => {
          const q = tx.objectStore('progress').get('current');
          q.onsuccess = () => { const v = q.result; res(v ? { byteLength: v.byteLength } : null); };
        });
      } catch (e) { return { err: e.message }; }
    });
    LOG('progress bytes in IDB after offline edit:', JSON.stringify(idb));
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => LOG('offload2 err', e.message));
  await page.waitForTimeout(3000);
  // After offline reload we're on the Ace *detail* page (route preserved), which
  // has a gift search box rather than the villager list search.
  const onDetail = (await page.locator('text=Gift ideas').count()) > 0;
  LOG('offline load2 OK?', onDetail);
  // The offline edit must survive the reload (recovered from IndexedDB).
  let editSurvived = false;
  if (onDetail) {
    if (await page.locator('details summary').count()) await page.locator('details summary').first().click();
    await page.waitForTimeout(800);
    editSurvived = (await page.locator('button[aria-label="Already gifted — undo"]').count()) > 0;
    LOG('edit survived offline reload?', editSurvived);
  }
  LOG(onDetail && editSurvived ? 'PASS' : 'FAIL');

  LOG('DONE');
  await browser.close();
} catch (e) {
  LOG('ERROR:', e.message);
  try { await page.screenshot({ path: 'offline-error.png' }); } catch {}
  await browser.close();
  process.exit(1);
}