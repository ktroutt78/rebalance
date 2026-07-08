// Right-side analytics column. Reads ONLY the shared selection state + a context
// snapshot. Renders, by mode:
//   - station selected → station header + hourly chart + the serving truck's load
//     profile (selected stop highlighted) + ranking,
//   - truck focused (legend) → truck header + load profile + ranking,
//   - nothing → system overview + system hourly + ranking.
// The load profile surfaces the solver's per-stop running inventory (it does NOT
// recompute it).

import { TRUCK_COLORS, formatDistance, routeHours } from './config.js';
import { hourlyChartSVG, rankingHTML, systemHourly, loadChartSVG, LOAD_CHART } from './charts.js';

const $ = (id) => document.getElementById(id);
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// Kept so the animation (Stage 3) + scrubber (Stage 4) can address the live
// load chart without a full re-render.
let loadCtx = null;

export function demandLabel(d) {
  if (d > 0) return `+${d} surplus`;
  if (d < 0) return `${d} deficit`;
  return 'balanced';
}
const demandClass = (d) => (d > 0 ? 'surplus' : d < 0 ? 'deficit' : 'neutral');

// Surface the solver's per-stop running load as a render-ready sequence.
export function buildLoadSequence(route, stationsByIdx) {
  return route.waypoints.map((wp) => {
    const isDepot = wp.station == null;
    const st = isDepot ? null : stationsByIdx.get(wp.station);
    return { load: wp.load, stationIdx: wp.station, isDepot, sign: st ? Math.sign(st.demand) : 0 };
  });
}

const block = (title, id, cls) =>
  `<section class="a-block"><h3 class="a-h3">${title}</h3><div id="${id}" class="${cls}"></div></section>`;

export function renderPanel(sel, ctx) {
  const root = $('analytics');
  if (!root || !ctx) return;

  const station =
    sel.stationIdx != null && ctx.stationsByIdx.has(sel.stationIdx) ? ctx.stationsByIdx.get(sel.stationIdx) : null;
  const truckIdx = sel.truckIdx;
  const route = truckIdx != null && ctx.routesByTruck ? ctx.routesByTruck.get(truckIdx) : null;

  // Two mutually-exclusive states — never stacked, so the panel never scrolls:
  //   DEFAULT  (nothing selected): system net-flow + the "Most Imbalanced" ranking
  //                                (the hero — how the viewer explores stations).
  //   SELECTED (a station/truck):  all about that selection — header + net-flow +
  //                                serving-truck load profile. Ranking is GONE; the
  //                                viewer navigates to other stations via the map.
  const selected = station != null || truckIdx != null;

  const header = station
    ? stationHeader(station, truckIdx)
    : truckIdx != null
    ? truckHeader(truckIdx, route, ctx)
    : systemHeader(ctx);

  // Three distinct states, never stacked, never scrolling:
  //   STATION SELECTED → station net-flow + serving-truck load profile. No ranking
  //                      (the panel is full; ranking is redundant on one station).
  //   TRUCK FOCUSED    → truck load profile + the ranking brought BACK (the view has
  //                      room and the ranking adds context; bars stay clickable).
  //   DEFAULT          → system net-flow + ranking (the hero).
  const blocks = [];
  if (station) {
    blocks.push(block('Net flow by hour', 'a-hourly', 'a-chart'));
    if (route) blocks.push(block(`Load profile · Vehicle ${truckIdx + 1}`, 'a-load', 'a-load-chart'));
  } else if (truckIdx != null) {
    if (route) blocks.push(block(`Load profile · Vehicle ${truckIdx + 1}`, 'a-load', 'a-load-chart'));
    blocks.push(block('Most imbalanced', 'a-rank', 'a-rank'));
  } else {
    blocks.push(block('Net flow by hour · system', 'a-hourly', 'a-chart'));
    blocks.push(block('Most imbalanced', 'a-rank', 'a-rank'));
  }

  const hint = !selected
    ? '<p class="a-hint">Click a station, a vehicle, or a ranking bar to focus.</p>'
    : route
    ? '<p class="a-hint">Drag across the load chart to scrub and read each stop’s load · ✕ or click the map to deselect.</p>'
    : '<p class="a-hint">✕ or click empty map space to deselect.</p>';

  root.innerHTML = header + blocks.join('') + hint;

  // Deselect affordance (selected state only) — the obvious way back to the ranking.
  const deselect = root.querySelector('.a-deselect');
  if (deselect) deselect.addEventListener('click', () => ctx.onClearSelection && ctx.onClearSelection());

  const hourlyEl = $('a-hourly');
  if (hourlyEl) hourlyEl.innerHTML = hourlyChartSVG(station ? station.hourly : systemHourly(ctx.stations));

  // Load profile (Stage 2). Keep loadCtx for the animation sync + scrubber.
  loadCtx = null;
  const loadEl = $('a-load');
  if (loadEl && route) {
    const seq = buildLoadSequence(route, ctx.stationsByIdx);
    const selectedIndex = station ? seq.findIndex((p) => p.stationIdx === station.idx) : -1;
    loadEl.innerHTML = loadChartSVG(seq, ctx.capacityFor(truckIdx), { selectedIndex });
    loadCtx = { el: loadEl, truckIdx, n: seq.length, seq, selectedIndex, ctx };
    wireLoadChart();
  }

  const rankEl = $('a-rank');
  if (rankEl) {
    rankEl.innerHTML = rankingHTML(ctx.stations, { selectedIdx: sel.stationIdx });
    wireRanking(rankEl, ctx);
  }
}

// Move the load chart's playhead to a sequence index (Stage 3 / 4). Cheap: one
// element repositioned, no re-render. Pass -1 to hide.
export function updateLoadPlayhead(truckIdx, index) {
  if (!loadCtx || loadCtx.truckIdx !== truckIdx) return;
  const svg = loadCtx.el.querySelector('svg');
  if (!svg) return;
  const ph = svg.querySelector('.load-playhead');
  if (!ph) return;
  const { W, padL, padR } = LOAD_CHART;
  const slot = (W - padL - padR) / Math.max(1, loadCtx.n);
  ph.setAttribute('x', index < 0 || index >= loadCtx.n ? -100 : padL + index * slot);
}

// The load chart's x-axis is a scrubber: drag to move the truck along its route;
// hover to light up a stop on the map; click a bar to select that stop (spine).
function wireLoadChart() {
  const svg = loadCtx.el.querySelector('svg');
  if (!svg) return;
  const { W, padL, padR } = LOAD_CHART;
  const idxAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    const frac = (clientX - r.left) / r.width;
    const slot = (W - padL - padR) / Math.max(1, loadCtx.n);
    return Math.max(0, Math.min(loadCtx.n - 1, (frac * W - padL) / slot));
  };
  let dragging = false;
  let moved = false;
  let downX = 0;

  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    downX = e.clientX;
    svg.setPointerCapture(e.pointerId);
    loadCtx.ctx.onScrubStart();
    const p = idxAt(e.clientX);
    updateLoadPlayhead(loadCtx.truckIdx, Math.round(p));
    loadCtx.ctx.onScrub(p);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (dragging) {
      if (Math.abs(e.clientX - downX) > 2) moved = true;
      const p = idxAt(e.clientX);
      updateLoadPlayhead(loadCtx.truckIdx, Math.round(p));
      loadCtx.ctx.onScrub(p);
    } else {
      const stop = loadCtx.seq[Math.round(idxAt(e.clientX))];
      loadCtx.ctx.onHoverStop(stop && stop.stationIdx != null ? stop.stationIdx : null);
    }
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    loadCtx.ctx.onScrubEnd();
    if (!moved) {
      // a plain click selects the stop — same selection spine as the map/legend/ranking
      const stop = loadCtx.seq[Math.round(idxAt(e.clientX))];
      if (stop && stop.stationIdx != null) loadCtx.ctx.onSelectStation(stop.stationIdx);
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', () => loadCtx.ctx.onHoverStop(null));
}

function wireRanking(rankEl, ctx) {
  const fire = (e) => {
    const row = e.target.closest('.rank-row');
    if (!row) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    ctx.onSelectStation(Number(row.dataset.idx));
  };
  rankEl.addEventListener('click', fire);
  rankEl.addEventListener('keydown', fire);
}

// ✕ button — the obvious, frictionless way back to the default ranking view.
const deselectBtn = '<button type="button" class="a-deselect" aria-label="Deselect — back to overview" title="Deselect">✕</button>';

function stationHeader(s, truckIdx) {
  const truck =
    truckIdx != null
      ? `<div class="a-truck"><span class="swatch" style="background:${rgb(
          TRUCK_COLORS[truckIdx % TRUCK_COLORS.length]
        )}"></span>Served by vehicle ${truckIdx + 1}</div>`
      : '';
  return `
    <header class="a-head">
      ${deselectBtn}
      <div class="a-eyebrow">Selected station</div>
      <h2 class="a-title">${escapeHtml(s.name)}</h2>
      <div class="a-demand ${demandClass(s.demand)}">${demandLabel(s.demand)}</div>
      ${truck}
    </header>`;
}

function truckHeader(truckIdx, route, ctx) {
  const color = TRUCK_COLORS[truckIdx % TRUCK_COLORS.length];
  const type = ctx.fleetTypes ? ctx.fleetTypes[truckIdx] : null;
  const stops = route ? route.stationIdxs.length : 0;
  const maxLoad = route ? route.maxLoad : 0;
  const dist = route ? formatDistance(route.distance) : '0 mi';
  const hours = route && type ? ` · ~${routeHours(type, route.distance, stops, route.bikesMoved).toFixed(1)} h` : '';
  return `
    <header class="a-head">
      ${deselectBtn}
      <div class="a-eyebrow">Focused vehicle</div>
      <h2 class="a-title"><span class="swatch lg" style="background:${rgb(color)}"></span>Vehicle ${truckIdx + 1}${
        type ? ` · ${type.name}` : ''
      }</h2>
      <div class="a-sub">${stops} stops · ${dist}${hours} · peak load ${maxLoad} / ${ctx.capacityFor(truckIdx)}</div>
    </header>`;
}

function systemHeader(ctx) {
  const m = ctx.metrics || {};
  return `
    <header class="a-head">
      <div class="a-eyebrow">System overview</div>
      <h2 class="a-title">Citi Bike rebalancing</h2>
      <div class="a-sub">${m.demandingStations ?? '—'} imbalanced stations · ${(m.bikesMoved ?? 0).toLocaleString()} bikes to move</div>
    </header>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
