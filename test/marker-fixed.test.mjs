// Confirm the moving truck marker is ONE fixed size for all trucks at all times —
// radius is decoupled from load. Watch a focused truck across its full route
// (depot→…→depot), including the at-capacity stop, and assert the marker radius
// never changes while the load it carries varies and reaches capacity.
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
// Dismiss the first-load intro card so it doesn't intercept map/chart interactions.
await page.evaluate(() => document.getElementById('intro-dismiss')?.click());

let fails = 0;
const check = (c, m, x) => { console.log(`${c ? '✓' : '✗'} ${m}${x ? ` (${x})` : ''}`); if (!c) fails++; };

// Focus the truck that reaches capacity (its profile spans empty → full).
const C = 30;
const info = await page.evaluate(() => {
  const r = window.__rebalance.routes();
  let best = r[0], mx = -1;
  for (const x of r) { const m = Math.max(...x.waypoints.map((w) => w.load)); if (m > mx) { mx = m; best = x; } }
  window.__rebalance.focusTruck(best.truckIndex);
  const loads = best.waypoints.map((w) => w.load);
  return { n: best.waypoints.length, peak: mx, peakIdx: loads.indexOf(mx) };
});
await page.waitForTimeout(300);
check(info.peak >= C, 'focused truck actually reaches capacity', `peak ${info.peak}`);

// Drag a single scrub across the whole sequence; the clock is frozen at each
// sampled stop, so load + radius reads are deterministic. Sample every stop.
const box = await page.locator('#a-load svg').boundingBox();
await page.mouse.move(box.x + box.width * 0.001, box.y + box.height / 2);
await page.mouse.down();

const radii = new Set();
const loads = [];
let saw3030 = false;
const SAMPLES = Math.min(info.n, 40);
for (let s = 0; s < SAMPLES; s++) {
  const fx = s / (SAMPLES - 1);
  await page.mouse.move(box.x + box.width * Math.min(0.999, fx), box.y + box.height / 2);
  const r = await page.evaluate(() => ({
    radius: window.__rebalance.markerRadius(),
    load: window.__rebalance.focusedLoad(),
  }));
  radii.add(r.radius);
  const n = Number((r.load || '').split('/')[0]);
  loads.push(n);
  if (r.load === `${C}/${C}`) saw3030 = true;
}
// The readout snaps to discrete per-stop loads, so land PRECISELY on the peak stop
// (the evenly-spaced sweep above can skip a single stop). LOAD_CHART: W=280, pad=4.
const slot = (280 - 8) / info.n;
const peakFrac = Math.min(0.999, Math.max(0.001, (4 + info.peakIdx * slot) / 280));
await page.mouse.move(box.x + box.width * peakFrac, box.y + box.height / 2);
const peakRead = await page.evaluate(() => ({ radius: window.__rebalance.markerRadius(), load: window.__rebalance.focusedLoad() }));
radii.add(peakRead.radius);
loads.push(Number((peakRead.load || '').split('/')[0]));
if (peakRead.load === `${C}/${C}`) saw3030 = true;
await page.mouse.up();

const minL = Math.min(...loads), maxL = Math.max(...loads);
check(maxL > minL, 'load varies across the route', `${minL}…${maxL}`);
check(saw3030 || maxL >= C, 'route passes through the 30/30 at-capacity stop', `max ${maxL}`);
check(radii.size === 1, 'marker radius is a single constant across the whole route', `radii: ${[...radii].join(',')}`);
const r0 = [...radii][0];
check(typeof r0 === 'number' && r0 >= 6, 'radius is one fixed legible value, not load-derived', `${r0}px`);

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(fails === 0 ? '\n✓ FIXED MARKER PASS' : `\n✗ FIXED MARKER FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
