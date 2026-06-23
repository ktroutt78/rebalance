// Headless browser smoke test of the full loop: load → solve → animate.
// Uses system Chrome via Playwright. Run with the dev server on :5174.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5174/';
const errors = [];
const logs = [];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`reqfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });

let ok = false;
try {
  // Wait until the loading overlay is hidden AND total distance is populated.
  await page.waitForFunction(
    () => {
      const l = document.getElementById('loading');
      const t = document.getElementById('m-total');
      return l && l.classList.contains('hidden') && t && t.textContent !== '—';
    },
    { timeout: 45000 }
  );
  ok = true;
} catch (e) {
  errors.push(`timeout waiting for solved state: ${e.message}`);
}

const metrics = await page.evaluate(() => ({
  total: document.getElementById('m-total')?.textContent,
  moved: document.getElementById('m-moved')?.textContent,
  satisfied: document.getElementById('m-satisfied')?.textContent,
  status: document.getElementById('solve-status')?.textContent,
  trucks: document.querySelectorAll('.truck-row').length,
  loadingHidden: document.getElementById('loading')?.classList.contains('hidden'),
}));

// Let it animate a moment, then grab a screenshot for visual proof.
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test/smoke.png' });

await browser.close();

console.log('--- metrics ---');
console.log(JSON.stringify(metrics, null, 2));
console.log('--- console (last 12) ---');
console.log(logs.slice(-12).join('\n'));
if (errors.length) {
  console.log('--- errors ---');
  console.log(errors.join('\n'));
}
const pass = ok && metrics.total && metrics.total !== '—' && metrics.trucks > 0;
console.log(pass ? '\n✓ SMOKE PASS' : '\n✗ SMOKE FAIL');
process.exit(pass ? 0 : 1);
