// Capture the three deliverable states: default (nothing selected), a station
// selected (hourly profile + its truck focused), and a truck focused via legend.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5174/';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(
  () => window.__rebalance && document.getElementById('loading')?.classList.contains('hidden'),
  { timeout: 45000 }
);
await page.waitForTimeout(1200);

// 1) default
await page.screenshot({ path: 'test/shot-default.png' });

// 2) station selected — pick the most extreme-demand served station for drama
const info = await page.evaluate(() => {
  const r = window.__rebalance;
  const served = new Set(r.stationToTruck().keys());
  const st = r.stations().filter((s) => served.has(s.idx)).sort((a, b) => Math.abs(b.demand) - Math.abs(a.demand))[0];
  r.selectStation(st.idx);
  return { name: st.name, demand: st.demand, truck: r.getSelection().truckIdx };
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'test/shot-station.png' });

// 3) truck focused via legend (click a row)
await page.evaluate(() => {
  window.__rebalance.clearSelection();
  const row = document.querySelector('#truck-breakdown .truck-row');
  row && row.click();
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'test/shot-truck.png' });

await browser.close();
console.log('shots written: shot-default.png, shot-station.png, shot-truck.png');
console.log('selected station:', JSON.stringify(info));
