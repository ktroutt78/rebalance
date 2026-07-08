// Configuration finder verification + deliverable screenshots.
//  - button opens the overlay; sweep runs K=1..8 via the REAL solver (loading state)
//  - both stat cards + the chart reflect the real swept numbers (cross-checked
//    against an independent direct sweep through the same worker hook)
//  - no internal scroll in the overlay
//  - clicking a point applies that K to the map + closes the overlay
// Shots: test/shot-finder-open.png (chart + cards), test/shot-finder-applied.png (map)
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5174/';
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(
  () => window.__rebalance && document.getElementById('loading')?.classList.contains('hidden'),
  { timeout: 45000 }
);
await page.evaluate(() => document.getElementById('intro-dismiss')?.click());
await page.waitForTimeout(400);

let fails = 0;
const check = (c, m, x) => { console.log(`${c ? '✓' : '✗'} ${m}${x !== undefined ? ` (${x})` : ''}`); if (!c) fails++; };
const shown = (id) => page.evaluate((i) => !document.getElementById(i).classList.contains('hidden'), id);

// Capacity slider bounds (PART A).
const cBounds = await page.evaluate(() => {
  const c = document.getElementById('c-slider');
  return { min: c.min, max: c.max, value: c.value };
});
check(cBounds.min === '10' && cBounds.max === '40', 'capacity slider bounds 10–40', JSON.stringify(cBounds));
check(cBounds.value === '30', 'capacity default 30', cBounds.value);

// About copy line (PART A).
await page.evaluate(() => document.getElementById('help-btn').click());
await page.waitForTimeout(120);
const aboutText = (await page.evaluate(() => document.getElementById('about-overlay').innerText)).replace(/\s+/g, ' ');
check(
  aboutText.includes('Real Citi Bike rebalancing uses everything from 3-bike trailers to box trucks carrying a few dozen bikes. This models the larger trucks.'),
  'About copy line added verbatim'
);
check(!aboutText.includes('—') || !/trailers to box trucks—/.test(aboutText), 'no em dash in new copy line');
await page.evaluate(() => document.getElementById('about-close').click());
await page.waitForTimeout(80);

// Independent ground-truth sweep via the same worker hook the finder uses.
const truth = await page.evaluate(async () => {
  const r = window.__rebalance;
  const depot = r.depot ? r.depot() : null; // may not exist; fall back below
  // Use the live solver hook exposed for the finder if present; else re-run via
  // the debug surface. We replicate the finder's exact inputs.
  const C = Number(document.getElementById('c-slider').value);
  const out = [];
  for (let k = 1; k <= 8; k++) {
    const res = await window.__rebalance.solveOnce({ K: k, C });
    out.push({ k, distance: res.metrics.totalDistance, unserved: res.metrics.unsatisfied });
  }
  return { C, out };
});

// Open the finder; observe the loading state, then the results.
await page.evaluate(() => document.getElementById('finder-open').click());
check(await shown('finder-overlay'), 'finder overlay opens');
// Loading state appears (best-effort: it may flash quickly).
const sawLoading = await page.evaluate(() => !!document.querySelector('.finder-loading'));
check(sawLoading, 'loading state shown while sweeping');

// Wait for the chart to render.
await page.waitForFunction(() => !!document.querySelector('.finder-svg'), { timeout: 30000 });
await page.waitForTimeout(300);

// Recompute expected stat cards from the ground-truth sweep.
const expected = (() => {
  const out = truth.out;
  const full = out.find((r) => r.unserved === 0);
  const recommendedK = full ? full.k : null;
  let minK = out[0].k, minDist = out[0].distance;
  for (const r of out) if (r.distance < minDist - 1e-6) { minDist = r.distance; minK = r.k; }
  return { recommendedK, minK };
})();

const cards = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.finder-card-stat .finder-stat-value')).map((e) => e.textContent.trim()));
check(
  cards[0] === (expected.recommendedK != null ? String(expected.recommendedK) : '—'),
  'card 1 (fewest for full coverage) matches real sweep', `${cards[0]} vs ${expected.recommendedK}`
);
check(cards[1] === String(expected.minK), 'card 2 (distance min K) matches real sweep', `${cards[1]} vs ${expected.minK}`);

// Chart has 8 hit columns + both polylines.
const chartShape = await page.evaluate(() => ({
  hits: document.querySelectorAll('.finder-hit').length,
  dist: !!document.querySelector('.finder-line-dist'),
  uns: !!document.querySelector('.finder-line-uns'),
  halo: !!document.querySelector('.finder-rec-halo'),
}));
check(chartShape.hits === 8, 'chart has 8 clickable columns', chartShape.hits);
check(chartShape.dist && chartShape.uns, 'both distance + unserved lines drawn');
check(expected.recommendedK == null || chartShape.halo, 'recommended point marked');

// No internal scroll in the overlay card.
const noScroll = await page.evaluate(() => {
  const el = document.querySelector('.finder-card');
  return el.scrollHeight <= el.clientHeight + 1;
});
check(noScroll, 'finder overlay does not scroll internally');

await page.screenshot({ path: 'test/shot-finder-open.png' });

// Clicking outside dismisses.
await page.mouse.click(30, 450);
await page.waitForTimeout(120);
check(!(await shown('finder-overlay')), 'clicking outside dismisses overlay');

// Re-open and click a specific column to apply that K.
const applyK = expected.recommendedK || 6;
await page.evaluate(() => document.getElementById('finder-open').click());
await page.waitForFunction(() => !!document.querySelector('.finder-svg'), { timeout: 30000 });
await page.waitForTimeout(200);
await page.evaluate((k) => {
  const hit = document.querySelector(`.finder-hit[data-k="${k}"]`);
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, applyK);
await page.waitForTimeout(400);
check(!(await shown('finder-overlay')), 'overlay closes after applying a point');
const appliedK = await page.evaluate(() => Number(document.getElementById('k-slider').value));
check(appliedK === applyK, 'clicked point applied K to the Trucks slider', `${appliedK} vs ${applyK}`);

// Let the re-solve + camera settle, then capture the map.
await page.waitForTimeout(1400);
await page.screenshot({ path: 'test/shot-finder-applied.png' });

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(`\nsweep @C=${truth.C}:`, truth.out.map((r) => `K${r.k}:${(r.distance / 1000).toFixed(1)}km/${r.unserved}u`).join('  '));
console.log(fails === 0 ? '\n✓ FINDER PASS' : `\n✗ FINDER FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
