// Probe: cached google-mode config must paint "Continue with Google" on first
// render — no password form, no swap. Run: node /e2e/login-flash-probe.js
const { chromium } = require('playwright');

(async () => {
  const base = process.env.BASE_URL || 'http://host.docker.internal:8080';
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 1+2) Seed the cache BEFORE app scripts run (init script), and block the
  //      config endpoint entirely — only the cached value can decide paint.
  await page.route('**/api/auth/config', () => new Promise(() => {})); // hang
  await page.addInitScript(() =>
    localStorage.setItem('acnh.authcfg', JSON.stringify({ mode: 'google' })),
  );
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150);
  const html = await page.innerHTML('body');
  const google = html.includes('Continue with Google');
  const password = html.includes('Username');
  console.log(google && !password ? 'PASS: cached google config paints Google button on first render' : `FAIL: google=${google} passwordForm=${password}`);
  await page.screenshot({ path: '/e2e/login-google-first-paint.png' });

  // 3) Unknown config (fresh context: no cache, config hanging): gentle
  //    spinner, never a guessed form.
  const page2 = await browser.newPage();
  await page2.route('**/api/auth/config', () => new Promise(() => {})); // hang
  await page2.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(150);
  const html2 = await page2.innerHTML('body');
  const spinner = html2.includes('animate-spin') && html2.includes('Getting your island ready');
  const guessed = html2.includes('Username') || html2.includes('Continue with Google');
  console.log(spinner && !guessed ? 'PASS: unknown config shows gentle spinner, no guessed door' : `FAIL: spinner=${spinner} guessedForm=${guessed}`);
  await page2.screenshot({ path: '/e2e/login-spinner.png' });

  // 4) Real config round-trip (password dev server): resolves to password form
  //    and caches for the next visit.
  await page2.unroute('**/api/auth/config');
  await page2.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('input[name="username"]', { timeout: 5000 });
  console.log('PASS: live config resolves to the real door');
  const cached = await page2.evaluate(() => localStorage.getItem('acnh.authcfg'));
  console.log(cached && cached.includes('password') ? 'PASS: config cached for next visit' : `FAIL: cache=${cached}`);

  await browser.close();
})();
