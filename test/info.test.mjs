// Info layer: first-load intro card + recallable About panel. Verifies behavior
// (show on load, dismiss, recall via "?", close + click-outside), the EXACT verbatim
// copy, the Blue/Red coloring, and that neither overlay scrolls at 1500×900.
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
await page.waitForTimeout(400);

let fails = 0;
const check = (c, m, x) => { console.log(`${c ? '✓' : '✗'} ${m}${x ? ` (${x})` : ''}`); if (!c) fails++; };
const shown = (id) => page.evaluate((i) => !document.getElementById(i).classList.contains('hidden'), id);
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Exact verbatim fragments (must appear character-for-character).
const INTRO = [
  'Bike-share operators constantly move bikes between stations, by truck and trailer, often overnight. They take them from stations that fill up and deliver them to stations that run empty, so riders find a bike (and an open dock) when they need one. This is an interactive look at that problem, using a day of real Citi Bike trip data for Manhattan.',
  'Each dot is a station. Blue means a surplus: more bikes arrive than leave, so they pile up and need picking up. Red means a deficit: more bikes leave than arrive, so the station runs short and needs bikes dropped off. The lines are vehicle routes carrying bikes from the blue stations to the red ones.',
  'Click a vehicle, a station, or a station in the ranking to focus it. Adjust the fleet (bike trailers carry 3 bikes, cargo vans 12, box trucks 30) and watch the routes re-solve.',
  'The routing is solved from scratch. No mapping API does the optimization. Built by Keith Troutt with Claude Code.',
];
const ABOUT = [
  'The problem. This is a capacitated pickup-and-delivery routing problem, a cousin of the traveling salesman problem. Trucks start at a depot, pick up bikes from surplus stations, drop them at deficit ones, and return, without ever carrying more than their capacity. The goal is to satisfy every station\'s need with the least total driving. It\'s the same problem Citi Bike\'s operations team actually solves. The research-grade version uses integer programming for exact answers, while this tool uses a faster heuristic so it can re-solve interactively as you change the inputs.',
  'The data. Station locations and demand come from a representative weekday of real Citi Bike trips. A station\'s demand is its net flow, meaning bikes arriving minus bikes leaving over the day. Stations that stay one-directional (always emptying or always filling) are the ones that need a visit. Balanced stations barely register. Real Citi Bike rebalancing uses everything from 3-bike trailers to box trucks carrying a few dozen bikes, and this models that mix: trailers carrying 3, cargo vans carrying 12, box trucks carrying 30. The fleet finder prices each option with rough cost estimates, including time-and-a-half overtime for routes that run past an 8-hour overnight shift, so the dollar figures are illustrative, not quotes.',
  'Reading a focused vehicle. Click a vehicle to follow it. The load profile chart shows its inventory at every stop, from depot to depot, against its capacity. When a bar hits the ceiling, the vehicle is full, which is often why its route loops back: it can\'t pick up more until it drops some off. Drag across the chart to scrub the vehicle along its route and read its exact load at each stop.',
  'Net flow by hour. Click a station to see its imbalance across the day. Many stations swing, with a surplus in the morning and a deficit in the evening. That commuter pattern is what creates the whole problem.',
  'A finding. Bigger fleets don\'t always help: more routes can add total distance, and small vehicles can never serve the biggest stations. The cheapest plans often accept a little overtime rather than dispatch another truck, and sometimes park a spare vehicle outright. Most decisive is the depot itself: move it and the best fleet changes.',
];

// --- first-load card shows on load ---
check(await shown('intro-overlay'), 'intro card shown on first load');
check(await shown('help-btn') !== false, 'help button present on load');

const introText = norm(await page.evaluate(() => document.getElementById('intro-overlay').innerText));
check(/^Rebalance/.test(introText), 'intro card titled "Rebalance"');
for (const frag of INTRO) check(introText.includes(norm(frag)), `intro verbatim: "${norm(frag).slice(0, 36)}…"`);
check(introText.includes('Got it, explore'), 'intro dismiss button reads "Got it, explore"');

// Blue/Red rendered with their colors.
const colors = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('#intro-overlay .c-surplus')).color;
  const d = getComputedStyle(document.querySelector('#intro-overlay .c-deficit')).color;
  return { s, d };
});
check(colors.s === 'rgb(42, 157, 244)', 'Blue rendered in the surplus color', colors.s);
check(colors.d === 'rgb(244, 91, 91)', 'Red rendered in the deficit color', colors.d);

// No scroll for the intro card.
const introNoScroll = await page.evaluate(() => {
  const el = document.querySelector('.intro-card');
  return el.scrollHeight <= el.clientHeight + 1;
});
check(introNoScroll, 'intro card does not scroll');
await page.screenshot({ path: 'test/shot-intro-card.png' });

// --- dismiss via its button ---
await page.evaluate(() => document.getElementById('intro-dismiss').click());
await page.waitForTimeout(80);
check(!(await shown('intro-overlay')), 'intro card dismissed by its button');

// --- "?" recalls the About panel ---
await page.evaluate(() => document.getElementById('help-btn').click());
await page.waitForTimeout(80);
check(await shown('about-overlay'), 'help "?" opens the About panel');

const aboutText = norm(await page.evaluate(() => document.getElementById('about-overlay').innerText));
check(aboutText.includes('About Rebalance'), 'About panel titled "About Rebalance"');
for (const frag of ABOUT) check(aboutText.includes(norm(frag)), `about verbatim: "${norm(frag).slice(0, 36)}…"`);
// The "Built by…/no optimization API" line was removed from About (redundant with the splash).
check(!aboutText.includes('The routing solver is hand-written'), 'redundant credit line removed from About');

// Section labels are bold.
const boldLabels = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#about-overlay .info-card strong')).map((s) => s.textContent));
for (const label of ['The problem.', 'The data.', 'Reading a focused vehicle.', 'Net flow by hour.', 'A finding.']) {
  check(boldLabels.includes(label), `section label bold: "${label}"`);
}

// No scroll for the About panel.
const aboutNoScroll = await page.evaluate(() => {
  const el = document.querySelector('.about-card');
  return el.scrollHeight <= el.clientHeight + 1;
});
check(aboutNoScroll, 'About panel does not scroll at 900px height');
await page.screenshot({ path: 'test/shot-about-panel.png' });

// --- dismiss via close button, then re-open and dismiss via click-outside ---
await page.evaluate(() => document.getElementById('about-close').click());
await page.waitForTimeout(80);
check(!(await shown('about-overlay')), 'About panel closed by ✕');

await page.evaluate(() => document.getElementById('help-btn').click());
await page.waitForTimeout(60);
await page.mouse.click(40, 450); // backdrop, away from the centered card
await page.waitForTimeout(80);
check(!(await shown('about-overlay')), 'About panel dismissed by clicking outside');

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(fails === 0 ? '\n✓ INFO LAYER PASS' : `\n✗ INFO LAYER FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
