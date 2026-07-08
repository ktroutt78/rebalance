// Fleet finder ("What's the cheapest fleet?"). An occasional analysis tool: on
// open it enumerates EVERY mix of vehicle types (up to each type's max, at most
// FLEET_MAX_TOTAL vehicles), runs the REAL solver once per mix (in the worker,
// off the UI thread), prices each solved plan with the config cost model, and
// charts the cheapest plan at every fleet size. Clicking a size applies its
// best mix to the map.
//
// This module owns ONLY the overlay + interaction. It reuses the existing
// solver (via the injected `solve`), metrics, and cost model — it never
// approximates. The solver keeps optimizing distance; dollars are a layer on
// top (config.js fleetCost), which is what makes "cheapest fleet" a fair,
// well-posed question to sweep.

import {
  VEHICLE_TYPES,
  FLEET_MAX_TOTAL,
  SHIFT,
  buildFleet,
  fleetCost,
  planMaxHours,
  planOvertimeHours,
  formatMoney,
  formatDistance,
} from './config.js';
import { finderChartSVG } from './charts.js';

const $ = (id) => document.getElementById(id);

// Every per-type count vector with 1..FLEET_MAX_TOTAL vehicles total.
function allMixes() {
  const mixes = [];
  const rec = (i, counts, total) => {
    if (i === VEHICLE_TYPES.length) {
      if (total >= 1) mixes.push({ ...counts });
      return;
    }
    const t = VEHICLE_TYPES[i];
    for (let n = 0; n <= t.max && total + n <= FLEET_MAX_TOTAL; n++) {
      counts[t.id] = n;
      rec(i + 1, counts, total + n);
    }
  };
  rec(0, {}, 0);
  return mixes;
}

const sizeOf = (counts) => VEHICLE_TYPES.reduce((s, t) => s + (counts[t.id] || 0), 0);

// "2 box trucks + 1 cargo van" — the human name of a mix.
export function mixWords(counts) {
  const parts = [];
  for (const t of VEHICLE_TYPES) {
    const n = counts[t.id] || 0;
    if (n > 0) parts.push(`${n} ${t.name.toLowerCase()}${n === 1 ? '' : 's'}`);
  }
  return parts.join(' + ');
}

// Plan ordering: coverage first, then dollars. A plan that serves every
// station beats any that doesn't, however cheap; among full-coverage plans
// the cost decides, and overtime is already priced into that cost.
const better = (a, b) => a.unserved - b.unserved || a.cost - b.cost;

// initFinder wires the open button + overlay. Dependencies are injected so this
// stays decoupled from app state:
//   solve({depot, fleet})  → Promise<{ metrics }>   (fleet = capacity array)
//   getContext()           → { depot }              (current depot at open time)
//   onApply(counts)        → set the fleet steppers, re-solve, show it on the map
export function initFinder({ solve, getContext, onApply }) {
  const overlay = $('finder-overlay');
  const body = $('finder-body');
  let running = false; // guard against re-entrant sweeps

  const open = () => overlay && overlay.classList.remove('hidden');
  const close = () => overlay && overlay.classList.add('hidden');

  $('finder-open')?.addEventListener('click', async () => {
    open();
    await runSweep();
  });
  $('finder-close')?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) close();
  });

  async function runSweep() {
    if (running) return;
    running = true;
    const mixes = allMixes();
    body.innerHTML = loadingHTML(mixes.length);
    const { depot } = getContext();

    const results = [];
    for (let i = 0; i < mixes.length; i++) {
      // Reflect progress so the wait reads as work, not a freeze.
      setProgress(i + 1, mixes.length);
      const counts = mixes[i];
      const fleet = buildFleet(counts);
      const r = await solve({ depot, fleet: fleet.map((t) => t.capacity) });
      // What actually ROLLS is the plan's real fleet — the solver sometimes
      // parks a vehicle whose cluster emptied, and a spare that parks costs
      // nothing (yet still shaped the route split). Plans are judged and
      // charted by their rolling composition; `counts` stays the recipe that
      // reproduces the solve.
      const rolling = {};
      let rollingSize = 0;
      for (const t of r.metrics.perTruck) {
        if (t.stops === 0) continue;
        const id = fleet[t.truckIndex].id;
        rolling[id] = (rolling[id] || 0) + 1;
        rollingSize++;
      }
      results.push({
        counts,
        size: sizeOf(counts),
        rolling,
        rollingSize,
        cost: fleetCost(fleet, r.metrics.perTruck), // overtime included
        unserved: r.metrics.unsatisfied,
        maxHours: planMaxHours(fleet, r.metrics.perTruck),
        otHours: planOvertimeHours(fleet, r.metrics.perTruck),
        idle: r.metrics.perTruck.filter((t) => t.stops === 0).length,
        distance: r.metrics.totalDistance,
      });
    }
    running = false;

    // Bail if the user closed the overlay mid-sweep.
    if (overlay.classList.contains('hidden')) return;
    renderResults(results);
  }

  function setProgress(i, total) {
    const el = $('finder-progress');
    if (el) el.textContent = `Solving mix ${i} of ${total}…`;
  }

  function renderResults(results) {
    // Best plan at each ROLLING size (coverage first, then cost) — the x-axis
    // answers "how many vehicles do I actually need on the road?", which is
    // the question. A mix that parks a spare competes at its rolling count.
    const bestAt = new Map();
    for (const r of results) {
      const cur = bestAt.get(r.rollingSize);
      if (!cur || better(r, cur) < 0) bestAt.set(r.rollingSize, r);
    }
    const points = [...bestAt.values()].sort((a, b) => a.rollingSize - b.rollingSize);

    // The recommendation: cheapest plan that serves every station, with
    // overtime already priced into the cost.
    const covered = results.filter((r) => r.unserved === 0);
    const recommended = covered.length ? covered.reduce((a, b) => (better(a, b) <= 0 ? a : b)) : null;

    // The box-trucks-only comparison lives in the caption (a fixed fact, not a
    // stat card; the second card tracks whatever column is selected). Judged
    // on what rolls: a plan whose vans/trailers all park IS trucks-only.
    const trucksOnly = covered.filter((r) => r.rollingSize === (r.rolling.truck || 0));
    const bestTrucksOnly = trucksOnly.length
      ? trucksOnly.reduce((a, b) => (better(a, b) <= 0 ? a : b))
      : null;

    body.innerHTML = `
      <div class="finder-cards">
        <div class="finder-card-stat">
          <span class="finder-stat-label">Cheapest full-coverage fleet</span>
          <span class="finder-stat-value">${recommended ? formatMoney(recommended.cost) : '—'}</span>
        </div>
        <div class="finder-card-stat">
          <span class="finder-stat-label" id="finder-sel-label">Selected fleet</span>
          <span class="finder-stat-value" id="finder-sel-value">—</span>
        </div>
        <div class="finder-card-stat">
          <span class="finder-stat-label">Longest route selected</span>
          <span class="finder-stat-value hours" id="finder-hrs-value">—</span>
        </div>
        <div class="finder-card-stat">
          <span class="finder-stat-label">Total distance selected</span>
          <span class="finder-stat-value dist" id="finder-dist-value">—</span>
        </div>
      </div>
      <div class="finder-chart" id="finder-chart">
        ${finderChartSVG(
          points.map((p) => ({ x: p.rollingSize, left: p.cost, right: p.maxHours })),
          {
            recommendedX: recommended ? recommended.rollingSize : null,
            leftTitle: 'cost of best mix ($)',
            rightTitle: 'longest route (h)',
            xTitle: 'vehicles on the road (best plan at each)',
            fmtLeft: (v) => `$${Math.round(v)}`,
            rightGuide: { value: SHIFT.hours, label: `${SHIFT.hours} h shift` },
            rightMaxHint: 24, // a full day of hours; the worst route is ~23 h
          }
        )}
      </div>
      <div class="finder-legend">
        <span><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#4cc9b0" stroke-width="2.4"/></svg> cost of best mix</span>
        <span><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#ffb44c" stroke-width="2.4" stroke-dasharray="4 3"/></svg> longest route</span>
        ${recommended ? `<span class="finder-legend-rec">◎ recommended (${recommended.rollingSize})</span>` : ''}
      </div>
      <div class="finder-pick" id="finder-pick"></div>
      <p class="finder-caption">${captionFor(results.length, recommended, bestTrucksOnly)}</p>
    `;

    // Clicking a column SELECTS that size's best mix: the second stat card and
    // the pick bar both update to spell out exactly what it is (mix, dollars,
    // coverage, shift fit) and WHY it beat the other mixes of that size, and
    // only the explicit apply button puts it on the map. The recommendation
    // starts selected so there's always a concrete plan on offer.
    const svg = body.querySelector('.finder-svg');
    const pickEl = body.querySelector('#finder-pick');
    const selLabel = body.querySelector('#finder-sel-label');
    const selValue = body.querySelector('#finder-sel-value');
    const hrsValue = body.querySelector('#finder-hrs-value');
    const distValue = body.querySelector('#finder-dist-value');
    let selectedSize = recommended ? recommended.rollingSize : points[points.length - 1]?.rollingSize ?? null;

    // Justify the winner against its same-size rivals: every mix of that size
    // was actually solved, so name the runner-up and the cheaper mix that got
    // rejected (and the reason it failed).
    const whyPick = (pick) => {
      const rivals = results.filter((r) => r.rollingSize === pick.rollingSize && r !== pick);
      const n = rivals.length + 1;
      if (pick.unserved > 0) {
        return `Of the ${n} solved plans that roll ${pick.rollingSize} vehicles, none serves every station; this one strands the fewest.`;
      }
      const parts = [
        `Of the ${n} solved plans that roll ${pick.rollingSize} vehicles, this is the cheapest that serves every station, overtime included.`,
      ];
      const nextBest = rivals.filter((r) => r.unserved === 0).sort((a, b) => a.cost - b.cost)[0];
      if (nextBest) parts.push(`Next best: ${mixWords(nextBest.rolling)} at ${formatMoney(nextBest.cost)}.`);

      // Optional context, capped at TWO sentences so the pick bar (and the
      // modal it sizes) never overgrows. Later entries outrank earlier ones.
      const extras = [];
      // Anything cheaper than a full-coverage winner must be stranding
      // stations (overtime is already in the price).
      const cheaper = rivals
        .filter((r) => r.unserved > 0 && r.cost < pick.cost - 0.5)
        .sort((a, b) => a.cost - b.cost)[0];
      if (cheaper) {
        extras.push(
          `${mixWords(cheaper.rolling)} would save ${formatMoney(pick.cost - cheaper.cost)} but leaves ${
            cheaper.unserved
          } station${cheaper.unserved === 1 ? '' : 's'} unserved.`
        );
      }
      // The price doesn't know that every vehicle is one more thing to own,
      // maintain, and staff — so when a leaner plan comes close, say so and
      // let the viewer weigh it.
      if (recommended && pick === recommended) {
        const lean = covered
          .filter((r) => r.rollingSize < pick.rollingSize && r.cost - pick.cost < pick.cost * 0.1)
          .sort((a, b) => a.rollingSize - b.rollingSize || a.cost - b.cost)[0];
        if (lean) {
          extras.push(
            `Prefer fewer vehicles to own and maintain? ${mixWords(lean.rolling)} covers everything with ${
              lean.rollingSize
            } on the road for ${formatMoney(lean.cost - pick.cost)} more.`
          );
        }
      }
      // A parked spare is a solver quirk worth explaining right where it shows.
      if (pick.idle > 0) {
        extras.push(
          `Applying sets the fleet to ${mixWords(pick.counts)}; the spare parks at the depot but shapes a better split.`
        );
      }
      parts.push(...extras.slice(-2));
      return parts.join(' ');
    };

    const renderPick = () => {
      const pick = selectedSize != null ? bestAt.get(selectedSize) : null;
      svg?.querySelectorAll('.finder-hit').forEach((h) => {
        h.classList.toggle('selected', Number(h.dataset.k) === selectedSize);
      });
      if (!pick) {
        pickEl.innerHTML = '';
        return;
      }
      const coveredPick = pick.unserved === 0;
      const coverage = coveredPick ? 'full coverage' : `${pick.unserved} stations unserved`;
      // Say when the plan keeps a spare — the headline counts what rolls, so
      // the stats must account for the rest of the applied fleet.
      const shiftNote =
        `longest route ${pick.maxHours.toFixed(1)} h` +
        (pick.otHours > 0 ? ` · ${pick.otHours.toFixed(1)} h overtime` : '') +
        (pick.idle > 0 ? ` · ${pick.idle} spare parked at the depot` : '');

      // Cards two and three track the selection for at-a-glance comparison
      // against the recommendation in card one — pure label + number; the
      // pick bar below the chart carries every detail. Colors follow the
      // chart's series: teal means dollars, orange means hours.
      selLabel.textContent = recommended && pick === recommended ? 'Selected fleet (recommended)' : 'Selected fleet';
      selValue.textContent = formatMoney(pick.cost);
      hrsValue.textContent = `${pick.maxHours.toFixed(1)} h`;
      distValue.textContent = formatDistance(pick.distance);

      pickEl.innerHTML = `
        <div class="finder-pick-info${coveredPick ? '' : ' warn'}">
          <strong>${pick.rollingSize} vehicle${pick.rollingSize === 1 ? '' : 's'} on the road · ${mixWords(pick.rolling)}</strong>
          <span class="finder-pick-stats">${formatMoney(pick.cost)} · ${formatDistance(pick.distance)} · ${coverage} · ${shiftNote}</span>
          <span class="finder-pick-why">${whyPick(pick)}</span>
        </div>
        <button type="button" id="finder-apply" class="info-btn finder-apply-btn">Put on the map</button>
      `;
      pickEl.querySelector('#finder-apply')?.addEventListener('click', () => {
        close();
        onApply({ ...pick.counts });
      });

      // Lock the bar to the tallest content seen — the recommendation renders
      // first and carries the longest why-text, so clicking around the chart
      // never resizes the bar (and the whole modal with it).
      const h = pickEl.offsetHeight;
      if (h > (parseFloat(pickEl.style.minHeight) || 0)) pickEl.style.minHeight = `${h}px`;
    };

    svg?.addEventListener('click', (e) => {
      const hit = e.target.closest('.finder-hit');
      if (!hit) return;
      const size = Number(hit.dataset.k);
      if (!bestAt.has(size)) return;
      selectedSize = size;
      renderPick();
    });
    renderPick();
  }

  function captionFor(mixCount, recommended, bestTrucksOnly) {
    const cap = `Every point is the cheapest of ${mixCount} solved mixes (up to 4 of each type, ${FLEET_MAX_TOTAL} total), grouped by how many vehicles actually roll; a spare that parks costs nothing but can still shape a better split. `;
    if (!recommended) {
      return cap + `Nothing serves every station; the dashed line shows each plan's longest route.`;
    }
    const trucksNote = bestTrucksOnly
      ? `The cheapest box-trucks-only plan runs ${formatMoney(bestTrucksOnly.cost)}.`
      : `No fleet of box trucks alone serves every station.`;
    return cap + `${trucksNote} Click a column to preview; move the depot and reopen to re-plan from there.`;
  }

  function loadingHTML(total) {
    return `
      <div class="finder-loading">
        <div class="spinner"></div>
        <p id="finder-progress">Solving mix 1 of ${total}…</p>
      </div>`;
  }
}
