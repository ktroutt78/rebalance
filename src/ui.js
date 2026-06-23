// Sliders + live metrics panel. Pure DOM; the map/solver live in main.js.

import { K_RANGE, C_RANGE, TRUCK_COLORS, formatDistance } from './config.js';

const $ = (id) => document.getElementById(id);

// Wire the K / C sliders. onChange(kind, value) fires on every input;
// main.js debounces the re-solve.
export function initControls({ onChange }) {
  const k = $('k-slider');
  const c = $('c-slider');

  k.min = K_RANGE.min;
  k.max = K_RANGE.max;
  k.value = K_RANGE.default;
  c.min = C_RANGE.min;
  c.max = C_RANGE.max;
  c.value = C_RANGE.default;
  $('k-val').textContent = k.value;
  $('c-val').textContent = c.value;

  k.addEventListener('input', () => {
    $('k-val').textContent = k.value;
    onChange('K', +k.value);
  });
  c.addEventListener('input', () => {
    $('c-val').textContent = c.value;
    onChange('C', +c.value);
  });

  return { K: +k.value, C: +c.value };
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

export function renderMetrics(metrics) {
  $('m-total').textContent = formatDistance(metrics.totalDistance);
  $('m-moved').textContent = metrics.bikesMoved.toLocaleString();
  $('m-satisfied').textContent = `${metrics.satisfied} / ${metrics.demandingStations}`;

  // Per-truck breakdown: color swatch, distance, max-load bar (vs capacity).
  const rows = metrics.perTruck
    .filter((t) => t.stops > 0)
    .map((t) => {
      const color = TRUCK_COLORS[t.truckIndex % TRUCK_COLORS.length];
      const loadPct = metrics.capacity > 0 ? Math.min(100, (t.maxLoad / metrics.capacity) * 100) : 0;
      return `
        <div class="truck-row" data-truck="${t.truckIndex}" role="button" tabindex="0" title="Focus truck ${t.truckIndex + 1}">
          <span class="swatch" style="background:${rgb(color)}"></span>
          <span class="t-name">${t.truckIndex + 1}</span>
          <span class="t-bar"><i style="width:${loadPct}%;background:${rgb(color)}"></i></span>
          <span>${formatDistance(t.distance)} · ${t.stops} stops · max ${t.maxLoad}</span>
        </div>`;
    })
    .join('');
  $('truck-breakdown').innerHTML = rows;

  const status = $('solve-status');
  if (metrics.unsatisfied > 0) {
    // State the true shortfall plainly. The cause varies (tight capacity at low C,
    // the cluster-first heuristic stranding stations at high K), so don't assert one.
    status.textContent = `⚠ ${metrics.unsatisfied} of ${metrics.demandingStations} stations unserved`;
    status.classList.add('warn');
  } else {
    status.textContent = `All ${metrics.demandingStations} imbalanced stations served.`;
    status.classList.remove('warn');
  }
}

// Legend entry point: a click (or keyboard activate) on a truck row focuses it.
export function bindTruckClicks(handler) {
  const el = $('truck-breakdown');
  const fire = (e) => {
    const row = e.target.closest('.truck-row');
    if (!row) return;
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
