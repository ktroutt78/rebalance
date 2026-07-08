// Fleet controls + live metrics panel. Pure DOM; the map/solver live in main.js.

import {
  VEHICLE_TYPES,
  FLEET_MAX_TOTAL,
  DEPOT_PRESETS,
  SHIFT,
  TRUCK_COLORS,
  formatDistance,
  fleetCost,
  planMaxHours,
  planOvertimeHours,
  formatMoney,
} from './config.js';

const $ = (id) => document.getElementById(id);

const totalOf = (counts) => VEHICLE_TYPES.reduce((s, t) => s + (counts[t.id] || 0), 0);

// Per-type steppers (one row per vehicle type). onChange(counts) fires on every
// click with a fresh counts object; main.js debounces the re-solve. Bounds:
// each type 0..type.max, whole fleet 1..FLEET_MAX_TOTAL (never empty — the map
// must always show a solved state). Clicking a type NAME fires
// onHighlight(typeId) — the map spotlight for that whole vehicle type.
let fleetState = null; // { counts, render } — kept so the finder can sync us
export function initFleetControls({ counts, onChange, onHighlight }) {
  const wrap = $('fleet-controls');
  const current = { ...counts };

  wrap.innerHTML = VEHICLE_TYPES.map(
    (t) => `
      <div class="fleet-row" data-type="${t.id}">
        <span class="fleet-name" role="button" tabindex="0" aria-pressed="false"
          title="Highlight every ${t.name.toLowerCase()} on the map"><i class="vdot ${t.id}"></i>${t.name} <small>· ${t.capacity} bikes</small></span>
        <span class="fleet-stepper">
          <button type="button" class="fleet-btn" data-delta="-1" aria-label="Fewer: ${t.name}">−</button>
          <strong class="fleet-count" data-count="${t.id}">0</strong>
          <button type="button" class="fleet-btn" data-delta="1" aria-label="More: ${t.name}">+</button>
        </span>
      </div>`
  ).join('');

  const render = () => {
    const total = totalOf(current);
    $('fleet-total').textContent = String(total);
    for (const t of VEHICLE_TYPES) {
      const row = wrap.querySelector(`.fleet-row[data-type="${t.id}"]`);
      const n = current[t.id] || 0;
      row.querySelector('.fleet-count').textContent = String(n);
      row.querySelector('[data-delta="1"]').disabled = n >= t.max || total >= FLEET_MAX_TOTAL;
      row.querySelector('[data-delta="-1"]').disabled = n <= 0 || total <= 1;
    }
  };

  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.fleet-btn');
    if (btn) {
      if (btn.disabled) return;
      const typeId = btn.closest('.fleet-row').dataset.type;
      current[typeId] = (current[typeId] || 0) + Number(btn.dataset.delta);
      render();
      onChange({ ...current });
      return;
    }
    const name = e.target.closest('.fleet-name');
    if (name && onHighlight) onHighlight(name.closest('.fleet-row').dataset.type);
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const name = e.target.closest('.fleet-name');
    if (!name || !onHighlight) return;
    e.preventDefault();
    onHighlight(name.closest('.fleet-row').dataset.type);
  });

  render();
  fleetState = { counts: current, render };
  return { ...current };
}

// Reflect the type spotlight back onto the fleet rows (null clears all).
export function setFleetHighlight(typeId) {
  document.querySelectorAll('#fleet-controls .fleet-row').forEach((row) => {
    const on = row.dataset.type === typeId;
    row.classList.toggle('highlighted', on);
    row.querySelector('.fleet-name')?.setAttribute('aria-pressed', String(on));
  });
}

// Sync the steppers to counts chosen elsewhere (the fleet finder's apply).
export function setFleetCounts(counts) {
  if (!fleetState) return;
  for (const t of VEHICLE_TYPES) fleetState.counts[t.id] = counts[t.id] || 0;
  fleetState.render();
}

// Named yard chips. onPick(preset) moves the depot + re-solves; the marker
// stays draggable for arbitrary spots (dragging just clears the active chip).
export function initDepotPresets({ onPick }) {
  const wrap = $('depot-presets');
  wrap.innerHTML = DEPOT_PRESETS.map(
    (p) => `<button type="button" data-depot="${p.id}" title="Move the depot to ${p.name} and re-solve">${p.name}</button>`
  ).join('');
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const preset = DEPOT_PRESETS.find((p) => p.id === b.dataset.depot);
    if (preset) onPick(preset);
  });
}

// Reflect the current depot back onto the chips: the matching preset lights
// up; a custom (dragged) spot lights none.
export function setDepotActive(depot) {
  document.querySelectorAll('#depot-presets button').forEach((b) => {
    const p = DEPOT_PRESETS.find((x) => x.id === b.dataset.depot);
    const on = !!p && Math.abs(p.lng - depot.lng) < 1e-6 && Math.abs(p.lat - depot.lat) < 1e-6;
    b.classList.toggle('active', on);
  });
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// Segmented animation-speed control. onChange(multiplier) fires on click.
export function initSpeedControl({ onChange, initial }) {
  const wrap = $('speed-buttons');
  const setActive = (val) => {
    wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === val));
  };
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const v = Number(b.dataset.speed);
    setActive(v);
    onChange(v);
  });
  setActive(initial);
  return initial;
}

// Play/pause is one half of the unified transport (the load-chart scrubber is the
// other). onToggle(playing) fires on click. Returns { initial, set } — `set` lets
// main.js force the button back to "playing" when a scrub ends (play resumes from
// the scrubbed point), so the button always reflects the real transport state.
export function initPlayToggle({ onToggle, initial = true }) {
  const btn = $('play-toggle');
  let playing = initial;
  const render = () => {
    btn.textContent = playing ? '⏸' : '▶';
    btn.setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
    btn.setAttribute('aria-pressed', String(playing));
    btn.classList.toggle('paused', !playing);
  };
  btn.addEventListener('click', () => {
    playing = !playing;
    render();
    onToggle(playing);
  });
  render();
  return {
    initial: playing,
    set: (p) => {
      if (p === playing) return;
      playing = p;
      render();
    },
  };
}

// fleet = per-vehicle type list (buildFleet output) aligned to truckIndex; it
// prices the plan and names/normalizes each row against its OWN capacity.
export function renderMetrics(metrics, fleet = []) {
  $('m-total').textContent = formatDistance(metrics.totalDistance);
  $('m-cost').textContent = formatMoney(fleetCost(fleet, metrics.perTruck));
  $('m-moved').textContent = metrics.bikesMoved.toLocaleString();
  $('m-satisfied').textContent = `${metrics.satisfied} / ${metrics.demandingStations}`;

  // Per-vehicle breakdown: color swatch, type, distance, max-load bar (vs its
  // own capacity, so a full trailer reads as full even next to a box truck).
  // Idle vehicles get an explicit ghosted row — the solver sometimes parks a
  // vehicle (its cluster emptied out), and a fleet of 5 must show 5 rows or
  // the map reads as missing one. Idle rows aren't clickable (nothing to focus).
  const rows = metrics.perTruck
    .map((t) => {
      const color = TRUCK_COLORS[t.truckIndex % TRUCK_COLORS.length];
      const type = fleet[t.truckIndex];
      if (t.stops === 0) {
        return `
        <div class="truck-row idle" title="Vehicle ${t.truckIndex + 1}${type ? ` — ${type.name}` : ''} has no route this plan">
          <span class="swatch" style="background:${rgb(color)}"></span>
          <span class="t-name">${t.truckIndex + 1}</span>
          <span class="t-type">${type ? type.short : ''}</span>
          <span class="t-idle">idle · parked at the depot</span>
        </div>`;
      }
      const cap = t.capacity ?? metrics.capacity;
      const loadPct = cap > 0 ? Math.min(100, (t.maxLoad / cap) * 100) : 0;
      return `
        <div class="truck-row" data-truck="${t.truckIndex}" role="button" tabindex="0" title="Focus vehicle ${t.truckIndex + 1}${type ? ` — ${type.name}` : ''}">
          <span class="swatch" style="background:${rgb(color)}"></span>
          <span class="t-name">${t.truckIndex + 1}</span>
          <span class="t-type">${type ? type.short : ''}</span>
          <span class="t-bar"><i style="width:${loadPct}%;background:${rgb(color)}"></i></span>
          <span>${formatDistance(t.distance)} · ${t.stops} stops · max ${t.maxLoad}/${cap}</span>
        </div>`;
    })
    .join('');
  $('truck-breakdown').innerHTML = rows;

  // Status states the true shortfall plainly (the cause varies: tight
  // capacities, or the cluster-first heuristic stranding stations, so don't
  // assert one) and notes overtime, which is priced into the cost above, not
  // a failure.
  const status = $('solve-status');
  const maxH = planMaxHours(fleet, metrics.perTruck);
  const otH = planOvertimeHours(fleet, metrics.perTruck);
  const shiftNote =
    maxH > 0
      ? ` · longest route ≈ ${maxH.toFixed(1)} h${otH > 0 ? ` · ${otH.toFixed(1)} h overtime` : ''}`
      : '';
  if (metrics.unsatisfied > 0) {
    status.textContent = `⚠ ${metrics.unsatisfied} of ${metrics.demandingStations} stations unserved${shiftNote}`;
  } else {
    status.textContent = `All ${metrics.demandingStations} imbalanced stations served${shiftNote}`;
  }
  status.classList.toggle('warn', metrics.unsatisfied > 0);
}

// Legend entry point: a click (or keyboard activate) on a truck row focuses it.
export function bindTruckClicks(handler) {
  const el = $('truck-breakdown');
  const fire = (e) => {
    const row = e.target.closest('.truck-row');
    if (!row || row.dataset.truck === undefined) return; // idle rows aren't focusable
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handler(Number(row.dataset.truck));
  };
  el.addEventListener('click', fire);
  el.addEventListener('keydown', fire);
}

// Reflect the shared selection back onto the legend rows.
export function highlightFocusedTruck(truckIdx) {
  document.querySelectorAll('#truck-breakdown .truck-row').forEach((row) => {
    row.classList.toggle('focused', Number(row.dataset.truck) === truckIdx);
  });
}

export function setSolveStatus(text) {
  $('solve-status').textContent = text;
}

export function hideLoading() {
  $('loading').classList.add('hidden');
}

export function setLoadingText(text) {
  $('loading-text').textContent = text;
}
