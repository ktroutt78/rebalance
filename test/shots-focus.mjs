// Deliverable shot: focused truck held mid-route at an at-capacity stop, showing
// the on-map "load/cap" readout + the load chart with at-capacity bars marked.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto('http://localhost:5174/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__rebalance && document.getElementById('loading')?.classList.contains('hidden'), { timeout: 45000 });
await page.evaluate(() => document.getElementById('intro-dismiss')?.click()); // dismiss first-load card

// Focus the truck that actually reaches capacity (most dramatic load profile).
const meta = await page.evaluate(() => {
  const r = window.__rebalance.routes();
  let best = r[0], mx = -1;
  for (const x of r) { const m = Math.max(...x.waypoints.map(w => w.load)); if (m > mx) { mx = m; best = x; } }
  window.__rebalance.focusTruck(best.truckIndex);
  const loads = best.waypoints.map(w => w.load);
  const n = loads.length;
  // first at-capacity stop, else the peak-load stop
  let i = loads.findIndex(l => l >= mx);
  return { truck: best.truckIndex, n, capIdx: i, peak: mx };
});
await page.waitForTimeout(400);

// Hold position at the at-capacity stop via an active scrub (pointer down = clock
// frozen). Target fraction ≈ (i+0.5)/n of the chart width.
const box = await page.locator('#a-load svg').boundingBox();
const frac = (meta.capIdx + 0.5) / meta.n;
await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(500); // let a (slow) frame render the held position
const readout = await page.evaluate(() => window.__rebalance.focusedLoad());
await page.screenshot({ path: 'test/shot-focus-load.png' });
await page.mouse.up();
await browser.close();
console.log('shot written: test/shot-focus-load.png');
console.log('focused truck:', meta.truck + 1, '· peak load:', meta.peak, '· readout:', readout);
