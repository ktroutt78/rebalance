// Fleet finder verification + deliverable screenshots.
//  - fleet steppers render with the default mix; button opens the overlay
//  - sweep runs EVERY vehicle mix via the REAL solver (loading state), prices
//    each plan, and the recommendation card matches an independent sweep run
//    through the same worker hook with the same cost + shift model
//  - chart: 8 columns, cost + longest-route lines, shift guide, recommended halo
//  - no internal scroll in the overlay
//  - clicking a column applies that size's best mix to the steppers + map
// Shots: test/shot-finder-open.png (chart + cards), test/shot-finder-applied.png (map)
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
await page.evaluate(() => document.getElementById('intro-dismiss')?.click());
await page.waitForTimeout(400);

let fails = 0;
const check = (c, m, x) => { console.log(`${c ? '✓' : '✗'} ${m}${x !== undefined ? ` (${x})` : ''}`); if (!c) fails++; };
const shown = (id) => page.evaluate((i) => !document.getElementById(i).classList.contains('hidden'), id);

// Mirror of the config cost + shift + overtime model. If config.js drifts,
// the card cross-check below fails — that's the point of an independent sweep.
const TYPES = [
  { id: 'truck', cap: 30, fx: 110, mi: 2.2, mph: 9, ot: 42, max: 4 },
  { id: 'van', cap: 12, fx: 60, mi: 1.25, mph: 10, ot: 33, max: 4 },
  { id: 'trailer', cap: 3, fx: 20, mi: 0.5, mph: 8, ot: 26, max: 4 },
];
const SHIFT_H = 8, MIN_STOP = 1, MIN_BIKE = 0.5, MAX_TOTAL = 8, MI = 1609.344;

// Fleet steppers render the default mix (the finder's own recommendation).
const steppers = await page.evaluate(() => ({
  rows: document.querySelectorAll('.fleet-row').length,
  total: document.getElementById('fleet-total').textContent,
  counts: Object.fromEntries(
    Array.from(document.querySelectorAll('.fleet-row')).map((r) => [r.dataset.type, r.querySelector('.fleet-count').textContent])
  ),
}));
check(steppers.rows === 3, 'three vehicle-type stepper rows', steppers.rows);
check(steppers.total === '7', 'default fleet totals 7 vehicles', steppers.total);
check(
  steppers.counts.truck === '2' && steppers.counts.van === '1' && steppers.counts.trailer === '4',
  'default mix is 2 trucks + 1 van + 4 trailers', JSON.stringify(steppers.counts)
);

// Independent ground-truth sweep via the same worker hook the finder uses.
console.log('ground-truth sweep (all mixes)…');
const truth = await page.evaluate(async ({ TYPES, SHIFT_H, MIN_STOP, MIN_BIKE, MAX_TOTAL, MI }) => {
  const mixes = [];
  for (let a = 0; a <= TYPES[0].max; a++)
    for (let b = 0; b <= TYPES[1].max; b++)
      for (let c = 0; c <= TYPES[2].max; c++) {
        const n = a + b + c;
        if (n >= 1 && n <= MAX_TOTAL) mixes.push([a, b, c]);
      }
  const out = [];
  for (const m of mixes) {
    const fleetTypes = [];
    m.forEach((n, i) => { for (let k = 0; k < n; k++) fleetTypes.push(TYPES[i]); });
    const res = await window.__rebalance.solveOnce({ fleet: fleetTypes.map((t) => t.cap) });
    let cost = 0, maxH = 0, otH = 0;
    for (const t of res.metrics.perTruck) {
      if (t.stops === 0) continue;
      const ty = fleetTypes[t.truckIndex];
      const h = t.distance / MI / ty.mph + (t.stops * MIN_STOP + t.bikesMoved * MIN_BIKE) / 60;
      const ot = Math.max(0, h - SHIFT_H);
      cost += ty.fx + (t.distance / MI) * ty.mi + ot * ty.ot;
      maxH = Math.max(maxH, h);
      otH += ot;
    }
    out.push({ m, size: m[0] + m[1] + m[2], cost, unserved: res.metrics.unsatisfied, maxH, otH });
  }
  return { count: mixes.length, out };
}, { TYPES, SHIFT_H, MIN_STOP, MIN_BIKE, MAX_TOTAL, MI });
console.log(`  ${truth.count} mixes solved`);

const covered = truth.out.filter((r) => r.unserved === 0);
const expectedRec = covered.length ? covered.reduce((a, b) => (a.cost <= b.cost ? a : b)) : null;

// Open the finder; observe the loading state, then the results.
await page.evaluate(() => document.getElementById('finder-open').click());
check(await shown('finder-overlay'), 'finder overlay opens');
const sawLoading = await page.evaluate(() => !!document.querySelector('.finder-loading'));
check(sawLoading, 'loading state shown while sweeping');

// Wait for the chart to render (the sweep is ~100 real solves).
await page.waitForFunction(() => !!document.querySelector('.finder-svg'), { timeout: 60000 });
await page.waitForTimeout(300);

// Card 1 (cheapest workable fleet) matches the independent sweep.
const cards = await page.evaluate(() => ({
  values: Array.from(document.querySelectorAll('.finder-card-stat .finder-stat-value')).map((e) => e.textContent.trim()),
  subs: Array.from(document.querySelectorAll('.finder-card-stat .finder-stat-sub')).map((e) => e.textContent.trim()),
}));
check(
  cards.values[0] === (expectedRec ? `$${Math.round(expectedRec.cost).toLocaleString('en-US')}` : '—'),
  'card 1 (cheapest workable fleet) matches real sweep',
  `${cards.values[0]} vs $${expectedRec ? Math.round(expectedRec.cost) : '—'}`
);
if (expectedRec) {
  const words = [
    [expectedRec.m[0], 'box truck'],
    [expectedRec.m[1], 'cargo van'],
    [expectedRec.m[2], 'bike trailer'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`)
    .join(' + ');
  check(cards.subs[0] === words, 'card 1 names the recommended mix', `${cards.subs[0]} vs ${words}`);
}

// Cards 2 + 3 track the SELECTION and open on the recommendation.
const fmt = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
check(
  cards.values[1] === (expectedRec ? fmt(expectedRec.cost) : '—'),
  'card 2 (selected fleet) opens on the recommendation',
  cards.values[1]
);
check(
  expectedRec == null || cards.values[2] === `${expectedRec.maxH.toFixed(1)} h`,
  'card 3 (longest route) opens on the recommendation',
  cards.values[2]
);

// The trucks-only fact lives in the caption, priced with overtime.
const captionText = await page.evaluate(() => document.querySelector('.finder-caption')?.textContent || '');
const trucksOnly = covered.filter((r) => r.m[1] === 0 && r.m[2] === 0);
check(
  trucksOnly.length ? captionText.includes('box-trucks-only plan runs') : captionText.includes('box trucks alone'),
  'caption states the box-trucks-only verdict'
);
check(captionText.includes('overtime'), 'caption explains the overtime pricing');

// No em dashes anywhere in the modal copy.
const modalText = await page.evaluate(() => document.querySelector('.finder-card')?.innerText || '');
check(!modalText.includes('—'), 'no em dashes in the finder modal');

// Right axis runs 0–24 (a full day of hours) in clean quarters; the labeled
// guide line marks the 8 h shift itself.
const rightTicks = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.finder-axis-r')).map((e) => e.textContent));
check(
  ['24', '18', '12', '6', '0'].every((t) => rightTicks.includes(t)),
  'right axis reads 0-24 hours in clean quarters',
  rightTicks.join(',')
);

// Chart shape: 8 hit columns, both lines, shift guide, recommended halo.
const chartShape = await page.evaluate(() => ({
  hits: document.querySelectorAll('.finder-hit').length,
  cost: !!document.querySelector('.finder-line-dist'),
  hours: !!document.querySelector('.finder-line-uns'),
  guide: !!document.querySelector('.finder-right-guide'),
  halo: !!document.querySelector('.finder-rec-halo'),
}));
check(chartShape.hits === 8, 'chart has 8 clickable columns', chartShape.hits);
check(chartShape.cost && chartShape.hours, 'cost + longest-route lines drawn');
check(chartShape.guide, 'shift-limit guide line drawn');
check(expectedRec == null || chartShape.halo, 'recommended point marked');

// No internal scroll in the overlay card.
const noScroll = await page.evaluate(() => {
  const el = document.querySelector('.finder-card');
  return el.scrollHeight <= el.clientHeight + 1;
});
check(noScroll, 'finder overlay does not scroll internally');

await page.screenshot({ path: 'test/shot-finder-open.png' });

// Clicking outside dismisses.
await page.mouse.click(30, 450);
await page.waitForTimeout(120);
check(!(await shown('finder-overlay')), 'clicking outside dismisses overlay');

// Re-open: the recommendation is PRE-SELECTED in the pick bar (confirmation
// before anything touches the map), clicking a column re-previews, and only
// the explicit apply button closes + applies.
const applySize = expectedRec ? expectedRec.size : 6;
await page.evaluate(() => document.getElementById('finder-open').click());
await page.waitForFunction(() => !!document.querySelector('.finder-svg'), { timeout: 60000 });
await page.waitForTimeout(200);
const prePick = await page.evaluate(() => document.querySelector('#finder-pick strong')?.textContent || '');
check(
  expectedRec == null || prePick.startsWith(`${expectedRec.size} vehicle`),
  'pick bar opens pre-selected on the recommendation',
  prePick
);

// When a leaner full-coverage fleet comes within 10% of the recommendation,
// the why-line surfaces it (maintenance and hiring aren't in the price).
const lean = expectedRec
  ? covered
      .filter((r) => r.size < expectedRec.size && r.cost - expectedRec.cost < expectedRec.cost * 0.1)
      .sort((a, b) => a.size - b.size || a.cost - b.cost)[0]
  : null;
const whyOpen = await page.evaluate(() => document.querySelector('.finder-pick-why')?.textContent || '');
check(
  !lean || whyOpen.includes('fewer vehicles to own and maintain'),
  'recommendation names the leaner near-price alternative',
  whyOpen.slice(-90)
);
// Click a DIFFERENT column → overlay stays open, pick bar previews that size.
const otherSize = applySize === 8 ? 6 : 8;
await page.evaluate((k) => {
  document.querySelector(`.finder-hit[data-k="${k}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, otherSize);
await page.waitForTimeout(150);
check(await shown('finder-overlay'), 'clicking a column previews without closing the overlay');
const otherPick = await page.evaluate(() => ({
  text: document.querySelector('#finder-pick strong')?.textContent || '',
  selectedCol: document.querySelector('.finder-hit.selected')?.dataset.k,
}));
check(otherPick.text.startsWith(`${otherSize} vehicle`), 'pick bar describes the clicked size', otherPick.text);
check(otherPick.selectedCol === String(otherSize), 'clicked column is marked selected', otherPick.selectedCol);

// The selected-fleet card follows the click, priced per the independent sweep
// (overtime included; ordering is coverage then cost).
const bestOfSize = (size) =>
  truth.out
    .filter((r) => r.size === size)
    .sort((a, b) => a.unserved - b.unserved || a.cost - b.cost)[0];
const selCard = await page.evaluate(() => document.getElementById('finder-sel-value')?.textContent);
check(selCard === fmt(bestOfSize(otherSize).cost), 'selected-fleet card updates with the click', selCard);
const hrsCard = await page.evaluate(() => ({
  value: document.getElementById('finder-hrs-value')?.textContent,
  sub: document.getElementById('finder-hrs-sub')?.textContent,
}));
const otherBest = bestOfSize(otherSize);
check(hrsCard.value === `${otherBest.maxH.toFixed(1)} h`, 'longest-route card updates with the click', hrsCard.value);
check(
  hrsCard.sub ===
    (otherBest.otH > 0 ? `${otherBest.otH.toFixed(1)} h total overtime` : `fits the ${SHIFT_H} h shift`),
  'longest-route card prices the overtime',
  hrsCard.sub
);

// The pick bar justifies the winner against its same-size rivals.
const why = await page.evaluate(() => document.querySelector('.finder-pick-why')?.textContent || '');
check(/All \d+ possible \d+-vehicle mixes were solved/.test(why), 'pick bar explains why the mix won', why.slice(0, 70));
// Back to the recommended size, then confirm via the apply button.
await page.evaluate((k) => {
  document.querySelector(`.finder-hit[data-k="${k}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, applySize);
await page.waitForTimeout(150);
await page.evaluate(() => document.getElementById('finder-apply').click());
await page.waitForTimeout(400);
check(!(await shown('finder-overlay')), 'apply button closes the overlay');
const applied = await page.evaluate(() => ({
  total: Number(document.getElementById('fleet-total').textContent),
  fleet: window.__rebalance.fleet(),
}));
const appliedTotal = Object.values(applied.fleet).reduce((s, n) => s + n, 0);
check(applied.total === applySize && appliedTotal === applySize, 'apply put the selected mix on the steppers', JSON.stringify(applied.fleet));

// Let the re-solve + camera settle, then capture the map.
await page.waitForTimeout(1400);
await page.screenshot({ path: 'test/shot-finder-applied.png' });

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
if (expectedRec) {
  console.log(
    `\nrecommended: truck=${expectedRec.m[0]} van=${expectedRec.m[1]} trailer=${expectedRec.m[2]} $${Math.round(expectedRec.cost)} maxH=${expectedRec.maxH.toFixed(1)}`
  );
}
console.log(fails === 0 ? '\n✓ FINDER PASS' : `\n✗ FINDER FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
