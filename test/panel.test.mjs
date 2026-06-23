// Stage 4 verification: charts render + the ranking bar is a real selection
// entry point. Also captures crisp close-ups of the analytics panel.
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
// Dismiss the first-load intro card so it doesn't cover the panel in screenshots.
await page.evaluate(() => document.getElementById('intro-dismiss')?.click());
await page.waitForTimeout(800);

let fails = 0;
const check = (cond, msg, ctx) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}${ctx ? ` (${ctx})` : ''}`);
  if (!cond) fails++;
};

// system default: chart + ranking present
const sys = await page.evaluate(() => ({
  bars: document.querySelectorAll('#a-hourly svg rect').length,
  ranks: document.querySelectorAll('#a-rank .rank-row').length,
}));
check(sys.bars === 24, 'system hourly chart has 24 bars', `${sys.bars}`);
check(sys.ranks > 0, 'ranking rendered', `${sys.ranks} rows`);
// DEFAULT state must not scroll.
const noScroll = (sel) =>
  page.evaluate((s) => { const el = document.querySelector(s); return el.scrollHeight <= el.clientHeight + 1; }, sel);
check(await noScroll('#analytics'), 'default state does not scroll');
await page.locator('#analytics').screenshot({ path: 'test/panel-system.png' });

// click a ranking bar → selects that station (third entry point)
const ranked = await page.evaluate(() => {
  const row = document.querySelector('#a-rank .rank-row');
  const idx = Number(row.dataset.idx);
  row.click();
  return { idx, sel: window.__rebalance.getSelection() };
});
check(ranked.sel.stationIdx === ranked.idx, 'ranking-bar click selects that station', `idx ${ranked.sel.stationIdx}`);
check(ranked.sel.truckIdx !== null, 'ranking click auto-focuses its truck', `truck ${ranked.sel.truckIdx}`);

const stationPanel = await page.evaluate(() => ({
  eyebrow: document.querySelector('#analytics .a-eyebrow')?.textContent,
  bars: document.querySelectorAll('#a-hourly svg rect').length,
  hasRanking: !!document.getElementById('a-rank'),
  hasLoad: !!document.getElementById('a-load'),
  hasDeselect: !!document.querySelector('#analytics .a-deselect'),
}));
check(stationPanel.eyebrow === 'Selected station', 'panel switched to station view');
check(stationPanel.bars === 24, 'station hourly chart has 24 bars');
check(stationPanel.hasLoad, 'serving-truck load profile shown in station view');
check(!stationPanel.hasRanking, 'ranking REMOVED in selected state (clean state swap)');
check(stationPanel.hasDeselect, 'deselect ✕ affordance present');
check(await noScroll('#analytics'), 'selected state does not scroll');
await page.locator('#analytics').screenshot({ path: 'test/panel-station.png' });

// ✕ returns to the default ranking view.
await page.evaluate(() => document.querySelector('#analytics .a-deselect').click());
await page.waitForTimeout(100);
const afterDeselect = await page.evaluate(() => ({
  eyebrow: document.querySelector('#analytics .a-eyebrow')?.textContent,
  ranks: document.querySelectorAll('#a-rank .rank-row').length,
  sel: window.__rebalance.getSelection(),
}));
check(afterDeselect.eyebrow === 'System overview', '✕ returns to default overview');
check(afterDeselect.ranks > 0, '✕ brings the ranking back');
check(afterDeselect.sel.stationIdx == null && afterDeselect.sel.truckIdx == null, '✕ clears the selection');

// Empty-map click also deselects (onDeckClick → clearSelection on empty space).
await page.evaluate(() => { document.querySelector('#a-rank .rank-row').click(); });
await page.waitForTimeout(80);
await page.evaluate(() => window.__rebalance.clearSelection());
await page.waitForTimeout(80);
const afterMapClear = await page.evaluate(() => ({
  eyebrow: document.querySelector('#analytics .a-eyebrow')?.textContent,
  ranks: document.querySelectorAll('#a-rank .rank-row').length,
}));
check(afterMapClear.eyebrow === 'System overview' && afterMapClear.ranks > 0, 'empty-map deselect returns to ranking view');

// TRUCK FOCUSED state (distinct from station-selected): load profile + ranking BACK.
const truckPanel = await page.evaluate(() => {
  const r = window.__rebalance.routes();
  const t = r.filter((x) => x.stationIdxs.length >= 2).sort((a, b) => b.stationIdxs.length - a.stationIdxs.length)[0];
  window.__rebalance.focusTruck(t.truckIndex);
  return {
    eyebrow: document.querySelector('#analytics .a-eyebrow')?.textContent,
    hasLoad: !!document.getElementById('a-load'),
    hasHourly: !!document.getElementById('a-hourly'),
    ranks: document.querySelectorAll('#a-rank .rank-row').length,
    hasDeselect: !!document.querySelector('#analytics .a-deselect'),
  };
});
check(truckPanel.eyebrow === 'Focused truck', 'truck-focus shows the focused-truck header');
check(truckPanel.hasLoad, 'truck-focus shows the load profile');
check(truckPanel.ranks > 0, 'truck-focus brings the ranking BACK', `${truckPanel.ranks} rows`);
check(!truckPanel.hasHourly, 'truck-focus has no net-flow chart (distinct from station view)');
check(truckPanel.hasDeselect, 'truck-focus has the deselect ✕');
check(await noScroll('#analytics'), 'truck-focus state does not scroll (load profile + ranking fit)');
await page.locator('#analytics').screenshot({ path: 'test/panel-truck.png' });

// Ranking stays clickable in truck-focus → clicking a bar selects that station.
const rankClick = await page.evaluate(() => {
  const row = document.querySelector('#a-rank .rank-row');
  const idx = Number(row.dataset.idx);
  row.click();
  return { idx, sel: window.__rebalance.getSelection() };
});
check(rankClick.sel.stationIdx === rankClick.idx, 'ranking bar still selects a station from truck-focus');

// Deselect works from the truck-focused state too.
await page.evaluate(() => window.__rebalance.clearSelection());
await page.waitForTimeout(80);
await page.evaluate(() => { const r = window.__rebalance.routes()[0]; window.__rebalance.focusTruck(r.truckIndex); });
await page.waitForTimeout(80);
await page.evaluate(() => document.querySelector('#analytics .a-deselect').click());
await page.waitForTimeout(100);
const afterTruckDeselect = await page.evaluate(() => document.querySelector('#analytics .a-eyebrow')?.textContent);
check(afterTruckDeselect === 'System overview', 'deselect works from truck-focus too');

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(fails === 0 ? '\n✓ PANEL/CHARTS PASS' : `\n✗ PANEL/CHARTS FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
