// UI smoke test — runs INSIDE mcr.microsoft.com/playwright:v1.62.1-noble.
// Usage: E2E_URL=http://localhost:8080 node ui-smoke.js
import { chromium } from 'playwright';

const base = process.env.E2E_URL || 'http://localhost:8080';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-ish

try {
  const resp = await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
  if (!resp || resp.status() !== 200) {
    console.error(`FAIL: page returned ${resp?.status()}`);
    process.exit(1);
  }
  const title = await page.title();
  console.log('page title:', title);

  // Login form should exist once the real client lands; for now the stub renders.
  const body = await page.textContent('body');
  if (!body || body.trim().length === 0) {
    console.error('FAIL: empty body');
    process.exit(1);
  }
  console.log('body preview:', body.trim().slice(0, 120));

  await page.screenshot({ path: '/e2e/smoke.png', fullPage: true });
  console.log('PASS: page rendered; screenshot -> tests/e2e/smoke.png');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
} finally {
  await browser.close();
}
