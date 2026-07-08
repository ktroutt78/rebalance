// Load-inspection feature: speed control, the focused truck's load profile,
// animation→playhead sync, and the x-axis scrubber (drag/hover/click).
// Needs the dev server on :5174.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5174/';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
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
const check = (c, m, x) => {
  console.log(`${c ? '✓' : '✗'} ${m}${x ? ` (${x})` : ''}`);
  if (!c) fails++;
};

// --- speed control ---
const dflt = await page.evaluate(() => window.__rebalance.anim().speed);
check(dflt < 1, 'default speed is slower than 1×', `${dflt}×`);
await page.evaluate(() => document.querySelector('#speed-buttons button[data-speed="0.25"]').click());
check(
  (await page.evaluate(() => window.__rebalance.anim().speed)) === 0.25,
  'speed control sets 0.25×'
);
// Part B1: a slower 0.1× crawl tier so the moving load tooltip is readable.
check(
  await page.evaluate(() => !!document.querySelector('#speed-buttons button[data-speed="0.1"]')),
  'slow 0.1× speed tier exists'
);
await page.evaluate(() => document.querySelector('#speed-buttons button[data-speed="0.1"]').click());
check((await page.evaluate(() => window.__rebalance.anim().speed)) === 0.1, 'speed control sets 0.1× crawl');

// --- focus the vehicle that gets closest to ITS OWN capacity; verify load chart ---
const info = await page.evaluate(() => {
  const r = window.__rebalance.routes();
  let best = r[0], mx = -1;
  for (const x of r) {
    const cap = window.__rebalance.capacityOf(x.truckIndex);
    if (!cap) continue;
    const m = Math.max(...x.waypoints.map((w) => w.load)) / cap;
    if (m > mx) { mx = m; best = x; }
  }
  window.__rebalance.focusTruck(best.truckIndex);
  return {
    loads: best.waypoints.map((w) => w.load),
    n: best.waypoints.length,
    cap: window.__rebalance.capacityOf(best.truckIndex),
  };
});
await page.waitForTimeout(300);
const C = info.cap; // the focused vehicle's OWN capacity (mixed fleet)
check(info.loads[0] === 0 && info.loads.at(-1) === 0, 'load starts & ends at depot = 0');
check(info.loads.every((l) => l >= 0 && l <= C), 'load never exceeds [0,C]', `max ${Math.max(...info.loads)}`);
const bars = await page.evaluate(() => document.querySelectorAll('#a-load svg .load-bar').length);
check(bars === info.n, 'one bar per visit-sequence point', `${bars}/${info.n}`);
check(
  await page.evaluate(() => !!document.querySelector('#a-load svg .cap-line')),
  'capacity ceiling line drawn'
);

// --- Stage 1: at-capacity bars are visually distinct + marked ---
const reachesCap = info.loads.some((l) => l >= C);
const atCapBars = await page.evaluate(() => document.querySelectorAll('#a-load svg .load-bar.at-cap').length);
const capMarks = await page.evaluate(() => document.querySelectorAll('#a-load svg .cap-mark').length);
check(!reachesCap || atCapBars > 0, 'full-capacity bars flagged .at-cap', `${atCapBars} bars`);
check(!reachesCap || capMarks === atCapBars, 'each at-capacity bar gets an amber cap mark', `${capMarks} marks`);

// --- scrubber drives the truck + playhead ---
const box = await page.locator('#a-load svg').boundingBox();
await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
await page.mouse.down();
const a = await scrubRead(box, 0.2);
const b = await scrubRead(box, 0.75);
check(a.scrub && b.scrub, 'scrubbing flag set during drag');
check(a.idx < b.idx, 'scrub moves truck along sequence', `${a.idx}→${b.idx}`);
check(a.ph < b.ph, 'playhead follows the scrub', `${a.ph}→${b.ph}`);
await page.mouse.up();
check((await page.evaluate(() => window.__rebalance.uiState().scrubbing)) === false, 'scrub ends on release');
check((await page.evaluate(() => window.__rebalance.anim().playing)) === true, 'play resumes after a scrub');

// --- Stage 2: play/pause is one transport — pause holds, play resumes forward ---
await page.evaluate(() => window.__rebalance.togglePlay()); // → paused
check((await page.evaluate(() => window.__rebalance.anim().playing)) === false, 'toggle pauses the animation');
const tPause = await page.evaluate(() => window.__rebalance.anim().currentTime);
await page.waitForTimeout(250);
const tStill = await page.evaluate(() => window.__rebalance.anim().currentTime);
check(Math.abs(tStill - tPause) < 1e-6, 'pause holds the truck in place', `${tPause}→${tStill}`);
await page.evaluate(() => window.__rebalance.togglePlay()); // → playing
// Wait on the condition, not a fixed timeout: under headless software-WebGL the
// deck.gl frame rate is a crawl, so a fixed wait may land zero frames.
const resumed = await page
  .waitForFunction((held) => window.__rebalance.anim().currentTime > held, tStill, { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
const tResume = await page.evaluate(() => window.__rebalance.anim().currentTime);
// Forward from the held point: a depot restart would read ~0 (< tStill) and fail here.
check(resumed && tResume > tStill, 'play resumes forward from the held position (not the depot)', `${tStill}→${tResume}`);

// --- Stage 3: on-map load readout tracks the focused truck's current load ---
const readout = await page.evaluate(() => window.__rebalance.focusedLoad());
check(/^\d+\/\d+$/.test(readout || ''), 'on-map load readout reads "load/capacity"', readout);
check((readout || '').endsWith(`/${C}`), 'readout denominator is the capacity', readout);

// --- Part B2: scrubbing shows CLEAN, ACCURATE per-stop loads (snapped to the stop,
// matching the load chart bars) — discrete values, never an interpolated in-between. ---
await page.mouse.move(box.x + box.width * 0.02, box.y + box.height / 2);
await page.mouse.down();
let snapOK = true;
const loadSet = new Set(info.loads);
const samples = [];
for (const fx of [0.1, 0.3, 0.45, 0.6, 0.8]) {
  await page.mouse.move(box.x + box.width * fx, box.y + box.height / 2);
  const r = await page.evaluate(() => {
    const m = /^(\d+)\/(\d+)$/.exec(window.__rebalance.focusedLoad() || '');
    return { idx: window.__rebalance.anim().stopIndex, load: m ? Number(m[1]) : NaN };
  });
  samples.push(`${r.idx}:${r.load}`);
  if (!Number.isInteger(r.load) || !loadSet.has(r.load) || r.load !== info.loads[r.idx]) snapOK = false;
}
await page.mouse.up();
check(snapOK, 'scrub readout snaps to the exact per-stop load (matches chart bars, no jitter)', samples.join(' '));

// --- hover highlights a map stop; click selects via the spine ---
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(100);
check(
  (await page.evaluate(() => window.__rebalance.uiState().hoveredStation)) !== null,
  'hover lights up the matching map stop'
);
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.6);
await page.waitForTimeout(150);
check(
  (await page.evaluate(() => window.__rebalance.getSelection().stationIdx)) !== null,
  'clicking a bar selects its stop (selection spine)'
);

check(errors.length === 0, 'no page errors', errors.join(' | '));

await browser.close();
console.log(fails === 0 ? '\n✓ LOAD INSPECTION PASS' : `\n✗ LOAD INSPECTION FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);

async function scrubRead(box, fx) {
  await page.mouse.move(box.x + box.width * fx, box.y + box.height / 2);
  return page.evaluate(() => ({
    scrub: window.__rebalance.uiState().scrubbing,
    idx: window.__rebalance.anim().stopIndex,
    ph: Number(window.__rebalance.playheadX()),
  }));
}
