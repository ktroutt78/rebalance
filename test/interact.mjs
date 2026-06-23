// Verifies the live re-solve loop: K slider, C slider, and depot drag each
// trigger a fresh solve and update the metrics panel.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:5174/';
const errors = [];
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('hidden') &&
        document.getElementById('m-total')?.textContent !== '—',
  { timeout: 45000 }
);

const read = () =>
  page.evaluate(() => ({
    total: document.getElementById('m-total').textContent,
    trucks: document.querySelectorAll('.truck-row').length,
    status: document.getElementById('solve-status').textContent,
  }));

const setSlider = async (id, value) => {
  await page.evaluate(
    ([id, value]) => {
      const el = document.getElementById(id);
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [id, value]
  );
};

// Wait on the DOM settling rather than a fixed delay — the first re-solve under
// headless software-WebGL can lag while initial shaders compile (instant on a
// real GPU). Condition-based waits make the test robust to that stall.
const waitForTrucks = (n) =>
  page.waitForFunction((n) => document.querySelectorAll('#truck-breakdown .truck-row').length === n, n, {
    timeout: 8000,
  });
const waitForTotalChange = (prev) =>
  page.waitForFunction((p) => document.getElementById('m-total').textContent !== p, prev, { timeout: 8000 });

let fails = 0;
const check = (cond, msg, ctx) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}${ctx ? ` (${ctx})` : ''}`);
  if (!cond) fails++;
};

const initial = await read();
console.log('initial:', JSON.stringify(initial));

// 1) K slider: 4 → 7 trucks should change the per-truck breakdown count.
await setSlider('k-slider', 7);
await waitForTrucks(7).catch(() => {});
const afterK = await read();
check(afterK.trucks === 7, 'K slider re-solves (7 truck rows)', `${initial.trucks}→${afterK.trucks}`);

// 2) C slider: tighten to the minimum should change total distance and likely strand some.
const beforeC = (await read()).total;
await setSlider('c-slider', 20);
await waitForTotalChange(beforeC).catch(() => {});
const afterC = await read();
check(afterC.total !== beforeC, 'C slider re-solves (total distance changed)', `${beforeC}→${afterC.total}`);

// restore a clean capacity before the depot test
const beforeRestore = (await read()).total;
await setSlider('c-slider', 40);
await waitForTotalChange(beforeRestore).catch(() => {});

// 3) Depot drag: grab the marker and drag it across the map.
const before = await read();
const box = await page.locator('.depot-marker').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + 220, box.y - 140, { steps: 12 });
await page.mouse.up();
await waitForTotalChange(before.total).catch(() => {});
const afterDrag = await read();
check(afterDrag.total !== before.total, 'depot drag re-solves (total distance changed)', `${before.total}→${afterDrag.total}`);

check(errors.length === 0, 'no page errors', errors.join(' | '));

await browser.close();
console.log(fails === 0 ? '\n✓ INTERACT PASS' : `\n✗ INTERACT FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
