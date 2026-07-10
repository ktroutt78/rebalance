// Vehicle-type spotlight: clicking a type name in the fleet panel highlights
// every vehicle of that type on the map (emphasis set), toggles off on second
// click, yields to a real selection, and clears on empty-map click.
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

const readState = () =>
  page.evaluate(() => ({
    type: window.__rebalance.highlightType(),
    trucks: window.__rebalance.highlightedTrucks(),
    fleetTypes: window.__rebalance.fleetTypes(),
    rows: Array.from(document.querySelectorAll('.fleet-row.highlighted')).map((r) => r.dataset.type),
    pressed: document.querySelector('.fleet-row[data-type="trailer"] .fleet-name')?.getAttribute('aria-pressed'),
    focusedTruck: window.__rebalance.getSelection().truckIdx,
  }));

const initialZoom = await page.evaluate(() => window.__rebalance.camera().zoom);

// 1) Click the trailer type name → spotlight all trailers.
await page.evaluate(() => document.querySelector('.fleet-row[data-type="trailer"] .fleet-name').click());
await page.waitForTimeout(150);
let s = await readState();
check(s.type === 'trailer', 'clicking the type name spotlights that type', s.type);
const expectedTrailers = s.fleetTypes.flatMap((id, i) => (id === 'trailer' ? [i] : []));
check(
  JSON.stringify(s.trucks) === JSON.stringify(expectedTrailers),
  'spotlight set is every vehicle of that type',
  `${JSON.stringify(s.trucks)} vs ${JSON.stringify(expectedTrailers)}`
);
check(s.rows.length === 1 && s.rows[0] === 'trailer', 'fleet row shows the highlighted state', JSON.stringify(s.rows));
check(s.pressed === 'true', 'type name is aria-pressed while active');

// Camera zooms in to fit the trailer routes (they cluster near the depot).
const zoomedIn = await page
  .waitForFunction(
    (z0) => { const c = window.__rebalance.camera(); return !c.moving && c.zoom > z0 + 0.2; },
    initialZoom,
    { timeout: 8000 }
  )
  .then(() => true)
  .catch(() => false);
const spotZoom = await page.evaluate(() => window.__rebalance.camera().zoom);
check(zoomedIn, 'spotlight zooms to fit the type’s routes', `${initialZoom.toFixed(2)} → ${spotZoom.toFixed(2)}`);

// 1b) The spotlight filters the analytics panel + lights the legend rows.
const spot = await page.evaluate(() => {
  const set = new Set(window.__rebalance.highlightedTrucks());
  const s2t = window.__rebalance.stationToTruck();
  const ranks = Array.from(document.querySelectorAll('#a-rank .rank-row'));
  return {
    eyebrow: document.querySelector('#analytics .a-eyebrow')?.textContent,
    bars: document.querySelectorAll('#a-hourly svg rect').length,
    rankCount: ranks.length,
    offFleet: ranks.filter((r) => !set.has(s2t.get(Number(r.dataset.idx)))).length,
    spotlit: document.querySelectorAll('#truck-breakdown .truck-row.spotlit').length,
  };
});
check(spot.eyebrow === 'Fleet spotlight', 'panel switches to the fleet-spotlight view', spot.eyebrow);
check(spot.bars === 24, 'spotlight net-flow chart renders (filtered)', `${spot.bars} bars`);
check(spot.rankCount > 0 && spot.offFleet === 0, 'ranking holds only stations this fleet serves', `${spot.rankCount} rows, ${spot.offFleet} off-fleet`);
check(spot.spotlit === expectedTrailers.length, 'legend rows of the spotlit type light up', `${spot.spotlit}/${expectedTrailers.length}`);

// 2) Second click toggles the spotlight off (and the camera flies back out).
await page.evaluate(() => document.querySelector('.fleet-row[data-type="trailer"] .fleet-name').click());
await page.waitForTimeout(150);
s = await readState();
check(s.type === null && s.rows.length === 0, 'second click toggles the spotlight off');
const zoomedOut = await page
  .waitForFunction(
    (z0) => { const c = window.__rebalance.camera(); return !c.moving && Math.abs(c.zoom - z0) < 0.05; },
    initialZoom,
    { timeout: 8000 }
  )
  .then(() => true)
  .catch(() => false);
check(zoomedOut, 'clearing the spotlight returns the camera to the default view');

// 2b) Toggling off restores the system panel + clears the legend rows.
const afterOff = await page.evaluate(() => ({
  eyebrow: document.querySelector('#analytics .a-eyebrow')?.textContent,
  spotlit: document.querySelectorAll('#truck-breakdown .truck-row.spotlit').length,
}));
check(afterOff.eyebrow === 'System overview' && afterOff.spotlit === 0, 'toggle-off restores the system panel + legend', `${afterOff.eyebrow}, ${afterOff.spotlit} spotlit`);

// 2c) ✕ in the spotlight panel exits the spotlight too.
await page.evaluate(() => document.querySelector('.fleet-row[data-type="trailer"] .fleet-name').click());
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('#analytics .a-deselect')?.click());
await page.waitForTimeout(150);
s = await readState();
check(s.type === null && s.rows.length === 0, '✕ in the spotlight panel exits the spotlight');

// 3) Spotlight yields to a real selection (focusing a vehicle clears it).
await page.evaluate(() => document.querySelector('.fleet-row[data-type="truck"] .fleet-name').click());
await page.waitForTimeout(100);
await page.evaluate(() => window.__rebalance.focusTruck(0));
await page.waitForTimeout(150);
s = await readState();
check(s.type === null && s.focusedTruck === 0, 'focusing a vehicle takes over from the spotlight', `type=${s.type}`);

// 4) Spotlighting while a vehicle is focused clears that focus.
await page.evaluate(() => document.querySelector('.fleet-row[data-type="van"] .fleet-name').click());
await page.waitForTimeout(150);
s = await readState();
check(s.type === 'van' && s.focusedTruck == null, 'spotlighting clears a focused vehicle', `type=${s.type} truck=${s.focusedTruck}`);

// 5) Clicking empty map space clears the spotlight.
await page.mouse.click(430, 90); // NJ-side empty map, clear of panels + stations
await page.waitForTimeout(250);
s = await readState();
check(s.type === null && s.rows.length === 0, 'empty-map click clears the spotlight');

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(fails === 0 ? '\n✓ TYPE SPOTLIGHT PASS' : `\n✗ TYPE SPOTLIGHT FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
