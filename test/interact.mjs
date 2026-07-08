// Verifies the live re-solve loop: fleet steppers and depot drag each trigger
// a fresh solve and update the metrics panel.
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

// The intro overlay intercepts pointer events; dismiss before the depot drag.
await page.evaluate(() => document.getElementById('intro-dismiss')?.click());

const read = () =>
  page.evaluate(() => ({
    total: document.getElementById('m-total').textContent,
    cost: document.getElementById('m-cost').textContent,
    fleetTotal: document.getElementById('fleet-total').textContent,
    trucks: document.querySelectorAll('.truck-row').length,
    status: document.getElementById('solve-status').textContent,
  }));

// Click a fleet stepper: type id ('truck'|'van'|'trailer'), delta (+1|-1).
const stepFleet = (typeId, delta) =>
  page.evaluate(
    ([typeId, delta]) => {
      document
        .querySelector(`.fleet-row[data-type="${typeId}"] .fleet-btn[data-delta="${delta}"]`)
        .click();
    },
    [typeId, String(delta)]
  );

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
check(/^\$\d/.test(initial.cost), 'fleet cost metric renders as dollars', initial.cost);

// 1) Removing a box truck should shrink the fleet and re-solve.
await stepFleet('truck', -1);
await waitForTotalChange(initial.total).catch(() => {});
const afterDec = await read();
check(Number(afterDec.fleetTotal) === Number(initial.fleetTotal) - 1, 'stepper − shrinks the fleet count', `${initial.fleetTotal}→${afterDec.fleetTotal}`);
check(afterDec.total !== initial.total, 'stepper − re-solves (total distance changed)', `${initial.total}→${afterDec.total}`);

// 2) Adding a cargo van should grow the fleet and re-solve again.
const beforeInc = afterDec;
await stepFleet('van', 1);
await waitForTotalChange(beforeInc.total).catch(() => {});
const afterInc = await read();
check(Number(afterInc.fleetTotal) === Number(beforeInc.fleetTotal) + 1, 'stepper + grows the fleet count', `${beforeInc.fleetTotal}→${afterInc.fleetTotal}`);
check(afterInc.total !== beforeInc.total, 'stepper + re-solves (total distance changed)', `${beforeInc.total}→${afterInc.total}`);
check(afterInc.cost !== initial.cost, 'fleet cost tracks the fleet change', `${initial.cost}→${afterInc.cost}`);

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
