// Configuration finder ("How many trucks do I need?"). An occasional analysis
// tool: on open it sweeps the truck count K = 1..8 at the CURRENT capacity, runs
// the REAL solver once per K (in the worker, off the UI thread), and charts the
// distance/coverage tradeoff. Clicking a point applies that K to the map.
//
// This module owns ONLY the overlay + interaction. It reuses the existing solver
// (via the injected `solve`) and the existing metrics — it never approximates.

import { finderChartSVG } from './charts.js';

const $ = (id) => document.getElementById(id);
const K_MIN = 1;
const K_MAX = 8;

// initFinder wires the open button + overlay. Dependencies are injected so this
// stays decoupled from app state:
//   solve({depot, K, C})  → Promise<{ metrics: { totalDistance, unsatisfied } }>
//   getContext()          → { depot, C }   (current depot + capacity at open time)
//   onApply(k)            → set the Trucks slider to k, re-solve, show it on the map
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
    body.innerHTML = loadingHTML();
    const { depot, C } = getContext();

    const results = [];
    for (let k = K_MIN; k <= K_MAX; k++) {
      // Reflect progress so the wait reads as work, not a freeze.
      setProgress(k);
      const r = await solve({ depot, K: k, C });
      results.push({ k, distance: r.metrics.totalDistance, unserved: r.metrics.unsatisfied });
    }
    running = false;

    // Bail if the user closed the overlay mid-sweep.
    if (overlay.classList.contains('hidden')) return;
    renderResults(results, C);
  }

  function setProgress(k) {
    const el = $('finder-progress');
    if (el) el.textContent = `Solving ${k} of ${K_MAX}…`;
  }

  function renderResults(results, C) {
    // Fewest trucks for full coverage: smallest K with zero unserved.
    const fullCoverage = results.find((r) => r.unserved === 0);
    const recommendedK = fullCoverage ? fullCoverage.k : null;

    // Distance stops improving after: the K at the minimum total distance
    // (smallest K on ties, since results are in ascending K order).
    let minK = results[0].k;
    let minDist = results[0].distance;
    for (const r of results) {
      if (r.distance < minDist - 1e-6) { minDist = r.distance; minK = r.k; }
    }

    body.innerHTML = `
      <div class="finder-cards">
        <div class="finder-card-stat">
          <span class="finder-stat-label">Fewest trucks for full coverage</span>
          <span class="finder-stat-value">${recommendedK != null ? recommendedK : '—'}</span>
          <span class="finder-stat-sub">${
            recommendedK != null
              ? `every imbalanced station served`
              : `no fleet of 1–${K_MAX} covers them all`
          }</span>
        </div>
        <div class="finder-card-stat">
          <span class="finder-stat-label">Distance stops improving after</span>
          <span class="finder-stat-value">${minK}</span>
          <span class="finder-stat-sub">${minK >= K_MAX ? 'still falling at 8' : `more trucks add distance`}</span>
        </div>
      </div>
      <div class="finder-chart" id="finder-chart">
        ${finderChartSVG(results, { recommendedK })}
      </div>
      <div class="finder-legend">
        <span><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#4cc9b0" stroke-width="2.4"/></svg> total distance</span>
        <span><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#ffb44c" stroke-width="2.4" stroke-dasharray="4 3"/></svg> stations unserved</span>
        ${recommendedK != null ? `<span class="finder-legend-rec">◎ recommended (${recommendedK})</span>` : ''}
      </div>
      <p class="finder-caption">${captionFor(results, recommendedK, minK, C)}</p>
    `;

    // Clicking a point (anywhere in its column) applies that truck count.
    const svg = body.querySelector('.finder-svg');
    svg?.addEventListener('click', (e) => {
      const hit = e.target.closest('.finder-hit');
      if (!hit) return;
      const k = Number(hit.dataset.k);
      if (!Number.isFinite(k)) return;
      close();
      onApply(k);
    });
  }

  function captionFor(results, recommendedK, minK, C) {
    const cap = `Each point is one real solve at capacity ${C}. `;
    if (recommendedK == null) {
      return cap + 'No fleet from 1 to 8 trucks covers every station at this capacity, the cluster-first heuristic strands stations as the work splits. Try raising capacity.';
    }
    const tail = recommendedK < minK
      ? `Past ${recommendedK} truck${recommendedK === 1 ? '' : 's'}, total distance keeps climbing without improving coverage.`
      : `Adding trucks beyond this point can increase total distance and even leave stations unserved, a limit of the cluster-first heuristic.`;
    return cap + `${recommendedK} truck${recommendedK === 1 ? '' : 's'} is the fewest that serves every station. ${tail}`;
  }

  function loadingHTML() {
    return `
      <div class="finder-loading">
        <div class="spinner"></div>
        <p id="finder-progress">Solving 1 of ${K_MAX}…</p>
      </div>`;
  }
}
