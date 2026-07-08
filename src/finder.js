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

    // The box-trucks-only comparison lives in the caption (a fixed fact, not a
    // stat card — the second card tracks whatever column is selected).
    const trucksOnly = workable.filter((r) => r.size === (r.counts.truck || 0));
    const bestTrucksOnly = trucksOnly.length
      ? trucksOnly.reduce((a, b) => (better(a, b) <= 0 ? a : b))
      : null;

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
          <span class="finder-stat-label" id="finder-sel-label">Selected fleet</span>
          <span class="finder-stat-value" id="finder-sel-value">—</span>
          <span class="finder-stat-sub" id="finder-sel-sub">click a column to compare</span>
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
    const selSub = body.querySelector('#finder-sel-sub');
    let selectedSize = recommended ? recommended.size : points[points.length - 1]?.size ?? null;

    // Justify the winner against its same-size rivals: every mix of that size
    // was actually solved, so name the runner-up and the cheaper mix that got
    // rejected (and the reason it failed).
    const whyPick = (pick) => {
      const rivals = results.filter((r) => r.size === pick.size && r !== pick);
      const n = rivals.length + 1;
      if (pick.unserved > 0 || pick.fits !== 0) {
        return `All ${n} possible ${pick.size}-vehicle mixes were solved; none serves every station within the shift, and this one comes closest.`;
      }
      const parts = [
        `All ${n} possible ${pick.size}-vehicle mixes were solved; this is the cheapest that serves every station within the shift.`,
      ];
      const nextBest = rivals
        .filter((r) => r.unserved === 0 && r.fits === 0)
        .sort((a, b) => a.cost - b.cost)[0];
      if (nextBest) parts.push(`Next best: ${mixWords(nextBest.counts)} at ${formatMoney(nextBest.cost)}.`);
      const cheaper = rivals.filter((r) => r.cost < pick.cost - 0.5).sort((a, b) => a.cost - b.cost)[0];
      if (cheaper) {
        const flaw =
          cheaper.unserved > 0
            ? `leaves ${cheaper.unserved} station${cheaper.unserved === 1 ? '' : 's'} unserved`
            : `needs a ${cheaper.maxHours.toFixed(1)} h route`;
        parts.push(
          `${mixWords(cheaper.counts)} would save ${formatMoney(pick.cost - cheaper.cost)} but ${flaw}.`
        );
      }
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
      const workable = pick.unserved === 0 && pick.fits === 0;
      const coverage = pick.unserved === 0 ? 'full coverage' : `${pick.unserved} stations unserved`;
      const shiftNote = `longest route ${pick.maxHours.toFixed(1)} h${
        pick.fits === 0 ? '' : ` (over the ${SHIFT.hours} h shift)`
      }`;

      // Second stat card tracks the selection for at-a-glance comparison
      // against the recommendation in card one.
      selLabel.textContent =
        recommended && pick.size === recommended.size ? 'Selected fleet (the recommendation)' : 'Selected fleet';
      selValue.textContent = formatMoney(pick.cost);
      selValue.classList.toggle('warn', !workable);
      selSub.textContent = `${pick.size} vehicle${pick.size === 1 ? '' : 's'} · ${coverage} · ${
        workable ? `fits the ${SHIFT.hours} h shift` : shiftNote
      }`;

      pickEl.innerHTML = `
        <div class="finder-pick-info${workable ? '' : ' warn'}">
          <strong>${pick.size} vehicle${pick.size === 1 ? '' : 's'} · ${mixWords(pick.counts)}</strong>
          <span class="finder-pick-stats">${formatMoney(pick.cost)} · ${coverage} · ${shiftNote}</span>
          <span class="finder-pick-why">${whyPick(pick)}</span>
        </div>
        <button type="button" id="finder-apply" class="info-btn finder-apply-btn">Put on the map</button>
      `;
      pickEl.querySelector('#finder-apply')?.addEventListener('click', () => {
        close();
        onApply({ ...pick.counts });
      });
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
    const cap = `Every point is the best of ${mixCount} solved fleet mixes at that size (up to 4 of each type, ${FLEET_MAX_TOTAL} vehicles total), judged by coverage first, then the ${SHIFT.hours}-hour overnight shift, then dollars. `;
    if (!recommended) {
      return cap + `Nothing up to ${FLEET_MAX_TOTAL} vehicles serves every station within the shift; the dashed line shows how far over each size runs.`;
    }
    const trucksNote = bestTrucksOnly
      ? `The cheapest box-trucks-only plan runs ${formatMoney(bestTrucksOnly.cost)}.`
      : `No fleet of box trucks alone finishes within the shift.`;
    return (
      cap +
      `Small fleets are cheap on paper but their routes blow past the shift line. ${trucksNote} Click a column to preview that size's best mix.`
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
