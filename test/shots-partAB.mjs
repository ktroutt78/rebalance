// Deliverables:
//  (a) shot-truck-panel.png   — truck-focused right panel: load profile + ranking restored
//  (b) shot-scrub-readout.png — truck mid-scrub with a clean on-map load readout
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto('http://localhost:5174/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__rebalance && document.getElementById('loading')?.classList.contains('hidden'), { timeout: 45000 });
await page.evaluate(() => document.getElementById('intro-dismiss')?.click()); // dismiss first-load card
await page.waitForTimeout(900);

// Focus the truck that reaches capacity (most readable load profile).
await page.evaluate(() => {
  const r = window.__rebalance.routes();
  let best = r[0], mx = -1;
  for (const x of r) { const m = Math.max(...x.waypoints.map((w) => w.load)); if (m > mx) { mx = m; best = x; } }
  window.__rebalance.focusTruck(best.truckIndex);
});
await page.waitForFunction(() => window.__rebalance.camera().moving === false, { timeout: 6000 }).catch(() => {});
await page.waitForTimeout(400);

// (a) truck-focused panel crop — load profile + "Most Imbalanced" ranking back
const a = await page.locator('#analytics').boundingBox();
await page.screenshot({ path: 'test/shot-truck-panel.png',
  clip: { x: a.x - 6, y: a.y - 6, width: a.width + 12, height: Math.min(a.height + 12, 880) } });

// (b) crawl speed, hold mid-route via an active scrub at the at-capacity stop, full page
await page.evaluate(() => document.querySelector('#speed-buttons button[data-speed="0.1"]').click());
const capFrac = await page.evaluate(() => {
  const r = window.__rebalance.routes();
  let best = r[0], mx = -1;
  for (const x of r) { const m = Math.max(...x.waypoints.map((w) => w.load)); if (m > mx) { mx = m; best = x; } }
  const loads = best.waypoints.map((w) => w.load);
  const i = loads.findIndex((l) => l >= mx);
  return (i + 0.5) / loads.length;
});
const box = await page.locator('#a-load svg').boundingBox();
await page.mouse.move(box.x + box.width * capFrac, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(500);
const readout = await page.evaluate(() => window.__rebalance.focusedLoad());
await page.screenshot({ path: 'test/shot-scrub-readout.png' });
await page.mouse.up();

await browser.close();
console.log('shots: test/shot-truck-panel.png, test/shot-scrub-readout.png · scrub readout:', readout);
