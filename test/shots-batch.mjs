// Deliverable shots for the batch:
//   (b) shot-system.png        — full-system view: white numbered trucks + skinny lines
//   (c) shot-ranking.png       — right panel crop: thicker "Most Imbalanced" bars
//   (a) shot-unserved.png      — high-K honest reporting + zoomed warn-orange ring
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto('http://localhost:5174/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__rebalance && document.getElementById('loading')?.classList.contains('hidden'), { timeout: 45000 });
await page.evaluate(() => document.getElementById('intro-dismiss')?.click()); // dismiss first-load card
await page.waitForTimeout(1200);

// (b) full-system view (default K=4): numbered white trucks + skinnier routes
await page.screenshot({ path: 'test/shot-system.png' });

// (c) right-panel crop with the thicker ranking bars
const aBox = await page.locator('#analytics').boundingBox();
await page.screenshot({ path: 'test/shot-ranking.png',
  clip: { x: aBox.x - 6, y: aBox.y - 6, width: aBox.width + 12, height: Math.min(aBox.height + 12, 880) } });

// (a) high-K → honest unserved reporting, then zoom the map to the missed station
await page.evaluate(() => { const k = document.getElementById('k-slider'); k.value = '8'; k.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForFunction(() => document.getElementById('k-val').textContent === '8', { timeout: 5000 });
await page.waitForFunction(() => window.__rebalance.unserved().length > 0, { timeout: 8000 }).catch(() => {});
const u = await page.evaluate(() => {
  const idxs = window.__rebalance.unserved();
  if (idxs.length) window.__rebalance.flyToStation(idxs[0], 14.2);
  return { idxs, status: document.getElementById('solve-status').textContent };
});
await page.waitForTimeout(1400);
await page.screenshot({ path: 'test/shot-unserved.png' });

await browser.close();
console.log('shots: test/shot-system.png, test/shot-ranking.png, test/shot-unserved.png');
console.log('high-K status:', u.status, '· unserved idxs:', JSON.stringify(u.idxs));
