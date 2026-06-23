// Auto-zoom-to-fit: focusing a truck smoothly frames its stops in the open band
// between the left control panel and right analytics panel; deselecting flies back
// to the default full-system view. Camera-only — solver/animation untouched.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5174/';
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const W = 1500, H = 900;
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(
  () => window.__rebalance && document.getElementById('loading')?.classList.contains('hidden'),
  { timeout: 45000 }
);
// Dismiss the first-load intro card so it doesn't intercept map/chart interactions.
await page.evaluate(() => document.getElementById('intro-dismiss')?.click());
await page.waitForTimeout(800);

let fails = 0;
const check = (c, m, x) => { console.log(`${c ? '✓' : '✗'} ${m}${x ? ` (${x})` : ''}`); if (!c) fails++; };
const settle = () => page.waitForFunction(() => window.__rebalance.camera().moving === false, { timeout: 6000 }).catch(() => {});

// Panel edges in screen px (left:16 w:320 → 336; right:16 w:300 → W-316).
const LEFT_EDGE = 336, RIGHT_EDGE = W - 316;

const def = await page.evaluate(() => window.__rebalance.camera());
check(def.framedTruck === null, 'starts at default framing (no truck framed)');

// Pick a truck with several stops, focus it, let the camera settle.
const t = await page.evaluate(() => {
  const r = window.__rebalance.routes();
  const best = r.filter((x) => x.stationIdxs.length >= 3).sort((a, b) => b.stationIdxs.length - a.stationIdxs.length)[0] || r[0];
  window.__rebalance.focusTruck(best.truckIndex);
  return { truck: best.truckIndex, stops: best.waypoints.filter((w) => w.station != null).map((w) => [w.lng, w.lat]) };
});
await settle();

const fit = await page.evaluate(() => window.__rebalance.camera());
check(fit.framedTruck === t.truck, 'camera framed the focused truck', `truck ${t.truck}`);
check(fit.zoom > def.zoom + 0.2, 'zoomed in to frame the route', `${def.zoom.toFixed(2)}→${fit.zoom.toFixed(2)}`);

// Every focused stop projects into the open band between the panels (not hidden).
const pts = await page.evaluate((stops) => stops.map((s) => window.__rebalance.project(s)), t.stops);
const inOpenArea = pts.every(([x, y]) => x >= LEFT_EDGE && x <= RIGHT_EDGE && y >= 0 && y <= H);
const xs = pts.map((p) => Math.round(p[0]));
check(inOpenArea, 'all focused stops sit in the open area between panels', `x∈[${Math.min(...xs)},${Math.max(...xs)}] vs (${LEFT_EDGE},${RIGHT_EDGE})`);

// Scrubbing/animation still work after the camera move.
const box = await page.locator('#a-load svg').boundingBox();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
await page.mouse.down();
const s1 = await page.evaluate(() => window.__rebalance.anim().stopIndex);
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
const s2 = await page.evaluate(() => window.__rebalance.anim().stopIndex);
await page.mouse.up();
check(s2 > s1, 'scrubbing still drives the truck after the camera move', `${s1}→${s2}`);

// Focusing a DIFFERENT truck re-fits.
const other = await page.evaluate(() => {
  const r = window.__rebalance.routes();
  const cur = window.__rebalance.getSelection().truckIdx;
  const o = r.find((x) => x.truckIndex !== cur && x.stationIdxs.length >= 2);
  window.__rebalance.focusTruck(o.truckIndex);
  return o.truckIndex;
});
await settle();
check((await page.evaluate(() => window.__rebalance.camera().framedTruck)) === other, 'focusing a different truck re-fits', `truck ${other}`);

// Deselect → smooth return to the default full-system view.
await page.evaluate(() => window.__rebalance.clearSelection());
await settle();
const back = await page.evaluate(() => window.__rebalance.camera());
check(back.framedTruck === null, 'deselect clears the framed truck');
check(Math.abs(back.zoom - def.zoom) < 0.05, 'returned to default zoom', `${back.zoom.toFixed(2)} vs ${def.zoom.toFixed(2)}`);
check(Math.abs(back.center[0] - def.center[0]) < 1e-3 && Math.abs(back.center[1] - def.center[1]) < 1e-3, 'returned to default center');

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(fails === 0 ? '\n✓ AUTOFIT PASS' : `\n✗ AUTOFIT FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
