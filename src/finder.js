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
  formatMoney,
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

// Plan ordering: coverage first, then shift feasibility, then dollars. A plan
// that serves every station beats any that doesn't; a plan whose routes all
// fit the overnight shift beats one that needs an impossible route; only then
// do dollars decide.
const better = (a, b) => a.unserved - b.unserved || a.fits - b.fits || a.cost - b.cost;

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
      const maxHours = planMaxHours(fleet, r.metrics.perTruck);
      results.push({
        counts,
        size: sizeOf(counts),
        cost: fleetCost(fleet, r.metrics.perTruck),
        unserved: r.metrics.unsatisfied,
        maxHours,
        fits: maxHours <= SHIFT.hours ? 0 : 1, // 0 = fits (sorts first)
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
    // Best plan at each fleet size (coverage first, then cost) — one chart
    // point per size, so the x-axis stays readable while every mix competes.
    const bestAt = new Map();
    for (const r of results) {
      const cur = bestAt.get(r.size);
      if (!cur || better(r, cur) < 0) bestAt.set(r.size, r);
    }
    const points = [...bestAt.values()].sort((a, b) => a.size - b.size);

    // The recommendation: cheapest plan that serves every station AND whose
    // every route fits the overnight shift.
    const workable = results.filter((r) => r.unserved === 0 && r.fits === 0);
    const recommended = workable.length ? workable.reduce((a, b) => (better(a, b) <= 0 ? a : b)) : null;

    // The headline comparison: the best box-trucks-only plan that's workable.
    const trucksOnly = workable.filter((r) => r.size === (r.counts.truck || 0));
    const bestTrucksOnly = trucksOnly.length
      ? trucksOnly.reduce((a, b) => (better(a, b) <= 0 ? a : b))
      : null;
    const saving = recommended && bestTrucksOnly ? bestTrucksOnly.cost - recommended.cost : null;

    body.innerHTML = `
      <div class="finder-cards">
        <div class="finder-card-stat">
          <span class="finder-stat-label">Cheapest workable fleet</span>
          <span class="finder-stat-value">${recommended ? formatMoney(recommended.cost) : '—'}</span>
          <span class="finder-stat-sub">${
            recommended
              ? mixWords(recommended.counts)
              : `no mix of 1–${FLEET_MAX_TOTAL} vehicles serves every station within the shift`
          }</span>
        </div>
        <div class="finder-card-stat">
          <span class="finder-stat-label">Box trucks only?</span>
          <span class="finder-stat-value">${saving != null ? formatMoney(saving) + ' more' : `> ${SHIFT.hours} h`}</span>
          <span class="finder-stat-sub">${
            saving != null
              ? `the cheapest all-truck plan costs ${formatMoney(bestTrucksOnly.cost)}`
              : `no all-truck fleet finishes the night's work within the ${SHIFT.hours}-hour shift`
          }</span>
        </div>
      </div>
      <div class="finder-chart" id="finder-chart">
        ${finderChartSVG(
          points.map((p) => ({ x: p.size, left: p.cost, right: p.maxHours })),
          {
            recommendedX: recommended ? recommended.size : null,
            leftTitle: 'cost of best mix ($)',
            rightTitle: 'longest route (h)',
            xTitle: 'fleet size (best mix at each)',
            fmtLeft: (v) => `$${Math.round(v)}`,
            rightGuide: { value: SHIFT.hours, label: `${SHIFT.hours} h shift` },
          }
        )}
      </div>
      <div class="finder-legend">
        <span><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#4cc9b0" stroke-width="2.4"/></svg> cost of best mix</span>
        <span><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#ffb44c" stroke-width="2.4" stroke-dasharray="4 3"/></svg> longest route</span>
        ${recommended ? `<span class="finder-legend-rec">◎ recommended (${recommended.size})</span>` : ''}
      </div>
      <p class="finder-caption">${captionFor(results.length, points, recommended)}</p>
    `;

    // Clicking a point (anywhere in its column) applies that size's best mix.
    const svg = body.querySelector('.finder-svg');
    svg?.addEventListener('click', (e) => {
      const hit = e.target.closest('.finder-hit');
      if (!hit) return;
      const size = Number(hit.dataset.k);
      const pick = bestAt.get(size);
      if (!pick) return;
      close();
      onApply({ ...pick.counts });
    });
  }

  function captionFor(mixCount, points, recommended) {
    const cap = `Every point is the best of ${mixCount} solved fleet mixes at that size — full coverage first, then routes that fit the ${SHIFT.hours}-hour overnight shift, then dollars. `;
    if (!recommended) {
      return cap + `Nothing up to ${FLEET_MAX_TOTAL} vehicles serves every station within the shift. The dashed line shows how far over each size runs.`;
    }
    return (
      cap +
      `Small fleets are cheap on paper but their routes blow past the shift line; ${mixWords(recommended.counts)} (${formatMoney(
        recommended.cost
      )}) is the cheapest plan that actually gets the night's work done. Click a column to put that fleet on the map.`
    );
  }

  function loadingHTML(total) {
    return `
      <div class="finder-loading">
        <div class="spinner"></div>
        <p id="finder-progress">Solving mix 1 of ${total}…</p>
      </div>`;
  }
}
