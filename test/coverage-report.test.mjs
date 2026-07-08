// Stage 1 — honest coverage reporting. A fleet of small vehicles can't serve
// big stations (service is atomic); the panel must report the TRUE
// served/unserved counts (not claim full coverage) and the map must flag the
// missed stations.
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

let fails = 0;
const check = (c, m, x) => { console.log(`${c ? '✓' : '✗'} ${m}${x ? ` (${x})` : ''}`); if (!c) fails++; };

// Default fleet (the finder's recommendation) serves everything → positive
// message, no unserved, and no shift warning.
const dflt = await page.evaluate(() => ({
  status: document.getElementById('solve-status').textContent,
  warn: document.getElementById('solve-status').classList.contains('warn'),
  unserved: window.__rebalance.unserved().length,
}));
check(dflt.unserved === 0 && !dflt.warn, 'default solution serves all stations', dflt.status);
check(/All \d+ imbalanced stations served/.test(dflt.status), 'positive message when fully covered');

// Swap to a trailers-only fleet — 3-bike trailers cannot serve big stations,
// so the report must state the (large) true shortfall.
await page.evaluate(() => {
  const step = (type, delta, times) => {
    for (let i = 0; i < times; i++)
      document.querySelector(`.fleet-row[data-type="${type}"] .fleet-btn[data-delta="${delta}"]`).click();
  };
  step('trailer', '1', 1); // 3 → 4
  step('truck', '-1', 3); // 3 → 0
  step('van', '-1', 1); // 1 → 0
});
await page.waitForFunction(() => document.getElementById('fleet-total').textContent === '4', { timeout: 5000 });
await page.waitForFunction(() => window.__rebalance.unserved().length > 0, { timeout: 8000 }).catch(() => {});

const hi = await page.evaluate(() => {
  const r = window.__rebalance;
  const stations = r.stations();
  const demanding = stations.filter((s) => s.demand !== 0).length;
  const m = document.getElementById('m-satisfied').textContent;
  const served = Number(m.split('/')[0].trim());
  return {
    status: document.getElementById('solve-status').textContent,
    warn: document.getElementById('solve-status').classList.contains('warn'),
    mSatisfied: m,
    served,
    demanding,
    unserved: r.unserved(),
  };
});
check(hi.unserved.length > 0, 'trailers-only fleet leaves stations unserved', `${hi.unserved.length} missed`);
check(hi.warn, 'status flips to a warning (not "all served")');
check(!/All \d+ imbalanced stations served/.test(hi.status), 'no false full-coverage claim', hi.status);
check(new RegExp(`${hi.unserved.length} of ${hi.demanding} stations unserved`).test(hi.status), 'states the true shortfall plainly', hi.status);
// The numbers are internally consistent: served + unserved === demanding.
check(hi.served + hi.unserved.length === hi.demanding, 'served + unserved === demanding', `${hi.served}+${hi.unserved.length}=${hi.demanding}`);
// Every unserved idx is a real demanding station (the solver's true output).
const allDemanding = await page.evaluate((idxs) =>
  idxs.every((i) => { const s = window.__rebalance.stations().find((x) => x.idx === i); return s && s.demand !== 0; }), hi.unserved);
check(allDemanding, 'unserved stations are genuinely demanding stations');

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(fails === 0 ? '\n✓ COVERAGE REPORT PASS' : `\n✗ COVERAGE REPORT FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
