// App bootstrap. Orchestrates the full loop:
//   DuckDB load → distance matrix → solver (worker) → deck.gl render + animate.
// Re-solves live on K/C slider changes and depot drag. A single selection state
// (src/selection.js) is the spine: it drives map focus, the legend, and the
// right-side analytics panel together.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';

import { MAP_STYLE, INITIAL_VIEW, DEFAULT_DEPOT, ANIM } from './config.js';
import { loadStations, computeDistanceMatrix } from './duckdb.js';
import { Solver } from './solver.js';
import {
  buildAnimationModel,
  stationLayer,
  routeLineLayer,
  tripsLayer,
  truckMarkerLayer,
  truckNumberLayer,
  truckLoadLabelLayer,
} from './layers.js';
import {
  initControls,
  initSpeedControl,
  initPlayToggle,
  renderMetrics,
  hideLoading,
  setLoadingText,
  bindTruckClicks,
  highlightFocusedTruck,
} from './ui.js';
import {
  getSelection,
  setSolution,
  selectStation,
  focusTruck,
  clearSelection,
  subscribe,
} from './selection.js';
import { renderPanel, updateLoadPlayhead } from './panel.js';
import { initInfo } from './info.js';
import { initFinder } from './finder.js';
import { inject as injectAnalytics } from '@vercel/analytics';

const state = {
  stations: [],
  stationsByIdx: new Map(),
  solver: null,
  depot: { ...DEFAULT_DEPOT },
  K: 4,
  C: 30,
  speed: ANIM.defaultSpeed,
  playing: true, // transport state: animation clock advances only while true
  scrubbing: false, // true while the user drags the load-chart scrubber (Stage 4)
  currentStopIndex: -1,
  hoveredStation: null, // chart bar hovered → transient map highlight
  model: [], // animation model from the latest solution
  metrics: null,
  stationToTruck: new Map(),
  unservedIdxs: new Set(), // stations the current solution left unserved (map treatment)
  framedTruck: null, // truck the camera is currently framed on (auto-zoom-to-fit)
  solving: false,
  pendingResolve: false,
};

// Auto-zoom-to-fit tuning. Padding keeps framed stops out from behind the left
// control panel (~336px) and right analytics panel (~316px), biasing the fit into
// the open map band between them. Clamped to the viewport in framePadding().
const CAMERA = { padLeft: 360, padRight: 340, padY: 48, duration: 850, maxZoom: 15 };

let map;
let overlay;
let playToggle; // transport button handle (set in boot); .set() syncs its glyph

async function boot() {
  // --- map + deck overlay ---
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
    zoom: INITIAL_VIEW.zoom,
    pitch: INITIAL_VIEW.pitch,
    bearing: INITIAL_VIEW.bearing,
    attributionControl: { compact: true },
  });
  overlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
    onClick: onDeckClick,
    getTooltip: ({ object }) =>
      object && object.demand !== undefined
        ? {
            html: `<strong>${object.name}</strong><br/>${
              object.demand > 0 ? `+${object.demand} surplus (pick up)` : `${object.demand} deficit (drop off)`
            }`,
            style: { background: '#12181f', color: '#e8edf2', fontSize: '12px', padding: '6px 8px', borderRadius: '6px' },
          }
        : null,
  });
  map.addControl(overlay);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  await new Promise((res) => (map.loaded() ? res() : map.on('load', res)));

  // --- data: load parquet + distance matrix via DuckDB ---
  setLoadingText('Loading station data…');
  state.stations = await loadStations();
  state.stationsByIdx = new Map(state.stations.map((s) => [s.idx, s]));

  setLoadingText('Computing distance matrix…');
  const matrix = await computeDistanceMatrix(state.stations);

  // --- solver worker ---
  state.solver = new Solver();
  state.solver.init(state.stations, matrix);

  // --- controls ---
  const initial = initControls({ onChange: onControlChange });
  state.K = initial.K;
  state.C = initial.C;

  // --- animation speed ---
  state.speed = initSpeedControl({ onChange: (s) => (state.speed = s), initial: state.speed });

  // --- transport: play/pause holds/advances the shared clock (never resets it) ---
  playToggle = initPlayToggle({ initial: state.playing, onToggle: (p) => (state.playing = p) });

  // --- selection wiring: legend → focusTruck; any change → re-render focus ---
  bindTruckClicks((t) => focusTruck(t));
  subscribe(onSelectionChange);

  // --- depot: draggable native marker, re-solve on drop ---
  createDepotMarker();

  // --- first solve, then reveal the (already animating) map ---
  setLoadingText('Solving initial rebalancing…');
  await resolve();
  renderPanel(getSelection(), panelContext());
  startAnimation();
  hideLoading();

  // Intro card over the (now solved + animating) map; "?" recalls the About panel.
  initInfo();

  // Configuration finder: sweeps K=1..8 at the current capacity via the real solver
  // worker, then a clicked point applies that K to the live map.
  initFinder({
    solve: ({ depot, K, C }) => state.solver.solve({ depot, K, C }),
    getContext: () => ({ depot: state.depot, C: state.C }),
    onApply: applyTruckCount,
  });

  exposeDebugHooks();

  // Vercel Web Analytics — injected LAST, here at the end of boot. Its insights
  // script instruments the page in a way that hangs DuckDB-Wasm's db.instantiate()
  // if it loads during boot; by this point DuckDB is fully initialized (it's only
  // used at boot — re-solves reuse the existing worker), so it's safe. We call it
  // directly rather than via requestIdleCallback, which the continuous rAF
  // animation loop would starve, delaying analytics indefinitely.
  injectAnalytics();
}

let resolveTimer = null;
function onControlChange(kind, value) {
  state[kind] = value;
  // Debounce slider drags so we re-solve on settle, not every pixel.
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(resolve, 90);
}

// Apply a truck count chosen in the configuration finder: sync the slider + its
// label, then re-solve immediately (no debounce — it's a deliberate single pick).
function applyTruckCount(k) {
  const slider = document.getElementById('k-slider');
  const label = document.getElementById('k-val');
  if (slider) slider.value = String(k);
  if (label) label.textContent = String(k);
  state.K = k;
  resolve();
}

// Solve with the current depot/K/C. Coalesces overlapping requests.
async function resolve() {
  if (state.solving) {
    state.pendingResolve = true;
    return;
  }
  state.solving = true;
  const result = await state.solver.solve({ depot: state.depot, K: state.K, C: state.C });
  state.model = buildAnimationModel(result.routes);
  state.metrics = result.metrics;
  state.unservedIdxs = new Set(result.unsatisfiedIdxs || []); // honest coverage → map treatment
  state.routes = result.routes; // keep raw routes: their waypoints[].load drives the load chart
  state.routesByTruck = new Map(result.routes.map((r) => [r.truckIndex, r]));
  state.stationToTruck = new Map();
  for (const r of result.routes) for (const s of r.stationIdxs) state.stationToTruck.set(s, r.truckIndex);

  renderMetrics(result.metrics);
  setSolution(result.routes); // refresh selection's station→truck + re-derive focus
  onSelectionChange(getSelection()); // re-apply legend highlight + panel after row rebuild

  state.solving = false;
  if (state.pendingResolve) {
    state.pendingResolve = false;
    resolve();
  }
}

// Single subscriber: keep the legend + panel in lockstep with the selection.
function onSelectionChange(sel) {
  highlightFocusedTruck(sel.truckIdx);
  renderPanel(sel, panelContext());
  updateCamera(sel);
}

// Auto-zoom-to-fit: move the camera only when the FOCUSED TRUCK changes — so
// re-selecting stations on the same truck (or a live re-solve) doesn't re-animate
// and disorient. Focus a truck → fit its route; clear focus → fly back to default.
function updateCamera(sel) {
  if (!map) return;
  const truck = sel.truckIdx;
  if (truck === state.framedTruck) return;
  state.framedTruck = truck;
  if (truck != null) fitToTruck(truck);
  else flyToDefault();
}

// Panel-aware padding clamped so we never pad away more than ~40% of an axis
// (keeps fitBounds well-behaved on small windows).
function framePadding() {
  const c = map.getContainer();
  const maxX = c.clientWidth * 0.4;
  const maxY = c.clientHeight * 0.4;
  return {
    left: Math.min(CAMERA.padLeft, maxX),
    right: Math.min(CAMERA.padRight, maxX),
    top: Math.min(CAMERA.padY, maxY),
    bottom: Math.min(CAMERA.padY, maxY),
  };
}

// Frame all waypoints of the focused truck (depot → stops → depot, so the depot
// legs stay on-screen as the truck animates). Smooth, quick, not a jump.
function fitToTruck(truckIdx) {
  const route = state.routesByTruck && state.routesByTruck.get(truckIdx);
  if (!route || !route.waypoints || !route.waypoints.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const w of route.waypoints) b.extend([w.lng, w.lat]);
  map.fitBounds(b, { padding: framePadding(), maxZoom: CAMERA.maxZoom, duration: CAMERA.duration });
}

// Back to the full-system view the app loads with.
function flyToDefault() {
  map.flyTo({
    center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
    zoom: INITIAL_VIEW.zoom,
    pitch: INITIAL_VIEW.pitch,
    bearing: INITIAL_VIEW.bearing,
    duration: CAMERA.duration,
  });
}

function panelContext() {
  return {
    stations: state.stations,
    stationsByIdx: state.stationsByIdx,
    metrics: state.metrics,
    stationToTruck: state.stationToTruck,
    routesByTruck: state.routesByTruck,
    capacity: state.C,
    onSelectStation: selectStation,
    onClearSelection: clearSelection, // ✕ in the selected-state header → back to default
    // Scrubber (Stage 4): the chart drives the truck's position on the map.
    onScrubStart: () => {
      state.scrubbing = true;
    },
    onScrub: (idxFloat) => driveScrub(idxFloat),
    onScrubEnd: () => {
      // Scrub + play are one system: releasing the scrub resumes playback FROM the
      // point the playhead was dragged to (animClock already sits there), never
      // from the depot. Force the transport back to "playing" so the button agrees.
      state.scrubbing = false;
      state.playing = true;
      playToggle?.set(true);
    },
    onHoverStop: (idx) => {
      state.hoveredStation = idx;
    },
  };
}

// Move the focused truck to a fractional point in its visit sequence by setting
// the shared animation clock — the map truck + trail re-render from it, in lockstep
// with the chart playhead. Reads the solver's per-stop timestamps; computes nothing new.
function driveScrub(idxFloat) {
  const sel = getSelection();
  if (sel.truckIdx == null) return;
  const truck = state.model.find((m) => m.truckIndex === sel.truckIdx);
  if (!truck) return;
  const st = truck.stopTimes;
  const n = st.length;
  const p = Math.max(0, Math.min(n - 1, idxFloat));
  const i = Math.min(n - 2, Math.floor(p));
  const frac = p - i;
  const time = st[i] + frac * ((st[i + 1] ?? st[i]) - st[i]);
  animClock = (time / ANIM.tripLength) * ANIM.loopMs;
  state.currentTime = time;
  state.currentStopIndex = Math.round(p);
}

// Map entry point: click a station → select it; click empty space → clear.
function onDeckClick(info) {
  if (info && info.object && info.layer && info.layer.id === 'stations') {
    selectStation(info.object.idx);
  } else if (info && info.layer && info.layer.id === 'depot') {
    /* depot is a separate marker; ignore */
  } else {
    clearSelection();
  }
}

function createDepotMarker() {
  const el = document.createElement('div');
  el.className = 'depot-marker';
  el.title = 'Depot — drag to relocate the yard';
  const marker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([state.depot.lng, state.depot.lat])
    .addTo(map);

  marker.on('drag', () => {
    const { lng, lat } = marker.getLngLat();
    state.depot = { lng, lat }; // live marker move; route updates on drop
  });
  marker.on('dragend', () => {
    const { lng, lat } = marker.getLngLat();
    state.depot = { lng, lat };
    resolve();
  });
}

// --- animation loop ---
// Accumulate a clock advanced by dt × speed, so changing speed re-paces smoothly
// instead of jumping phase (which `now % loopMs` with a changing period would).
let animClock = 0; // ms within the base loop period
let lastNow = null;
function startAnimation() {
  function frame(now) {
    // Advance the shared clock only while playing and not scrubbing. Pausing holds
    // position (clock frozen); scrubbing drives the clock directly via driveScrub.
    // The modulo wraps depot→depot seamlessly, so the route loops without a reset.
    if (lastNow != null && state.playing && !state.scrubbing) {
      animClock = (animClock + (now - lastNow) * state.speed) % ANIM.loopMs;
    }
    lastNow = now;
    state.currentTime = (animClock / ANIM.loopMs) * ANIM.tripLength;

    const sel = getSelection();
    const focus = {
      focusedTruck: sel.truckIdx,
      selectedStation: sel.stationIdx,
      stationToTruck: state.stationToTruck,
      hoveredStation: state.hoveredStation,
      unservedStations: state.unservedIdxs,
    };

    // Resolve the focused truck's current stop up front: while scrubbing the scrub
    // owns it (snapped, set in driveScrub); otherwise derive it from the clock. The
    // on-map load readout + chart playhead both read this, so they agree exactly.
    const focusTruck = sel.truckIdx != null ? state.model.find((m) => m.truckIndex === sel.truckIdx) : null;
    let focusStopIndex = -1;
    if (focusTruck) {
      focusStopIndex = state.scrubbing
        ? state.currentStopIndex
        : currentStopIndex(focusTruck.stopTimes, state.currentTime);
      if (!state.scrubbing) state.currentStopIndex = focusStopIndex;
    }

    overlay.setProps({
      layers: [
        stationLayer(state.stations, focus),
        routeLineLayer(state.model, focus),
        tripsLayer(state.model, state.currentTime, focus),
        truckMarkerLayer(state.model, state.currentTime, focus),
        truckNumberLayer(state.model, state.currentTime, focus),
        // On-map "load/cap" readout above the focused truck; load snaps to the stop.
        truckLoadLabelLayer(state.model, state.currentTime, state.C, focus, focusStopIndex),
      ].filter(Boolean),
    });

    // Keep the load chart's playhead on the focused truck's stop (the scrub drives
    // it directly while dragging, so only sync here when not scrubbing).
    if (focusTruck && !state.scrubbing) {
      updateLoadPlayhead(sel.truckIdx, focusStopIndex);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Largest stop index the truck has reached at time t (the stop it's at/departing).
function currentStopIndex(stopTimes, t) {
  let i = 0;
  for (let k = 0; k < stopTimes.length; k++) {
    if (stopTimes[k] <= t) i = k;
    else break;
  }
  return i;
}

// Small hooks so the headless tests can drive/observe the selection spine.
function exposeDebugHooks() {
  window.__rebalance = {
    getSelection,
    selectStation,
    focusTruck,
    clearSelection,
    stations: () => state.stations,
    depot: () => ({ ...state.depot }),
    // Run a single solve through the SAME worker the finder uses, without touching
    // app state — lets a test ground-truth the finder's sweep against the real solver.
    solveOnce: ({ K, C }) => state.solver.solve({ depot: state.depot, K, C }),
    stationToTruck: () => state.stationToTruck,
    unserved: () => [...state.unservedIdxs],
    // Pan/zoom the map to a station (used by screenshot tooling to frame the
    // warn-orange unserved ring); pure view change, no solver/state impact.
    flyToStation: (idx, zoom = 14) => {
      const s = state.stationsByIdx.get(idx);
      if (s && map) map.flyTo({ center: [s.lng, s.lat], zoom, duration: 0 });
    },
    // Camera introspection for the auto-fit test: project lng/lat → screen px,
    // read the live view, and whether the camera is mid-animation.
    project: ([lng, lat]) => { const p = map.project([lng, lat]); return [p.x, p.y]; },
    camera: () => ({ zoom: map.getZoom(), center: map.getCenter().toArray(), moving: map.isMoving(), framedTruck: state.framedTruck }),
    routes: () => state.routes,
    anim: () => ({
      currentTime: state.currentTime,
      speed: state.speed,
      stopIndex: state.currentStopIndex,
      playing: state.playing,
    }),
    togglePlay: () => document.getElementById('play-toggle')?.click(),
    // Load shown on the on-map readout — snapped to the current stop's load (the
    // same value the load chart bar shows), so tests can assert clean per-stop
    // values while scrubbing rather than an interpolated in-between number.
    focusedLoad: () => {
      const sel = getSelection();
      if (sel.truckIdx == null || !state.model.length) return null;
      const m = state.model.find((x) => x.truckIndex === sel.truckIdx);
      if (!m || !m.stopLoads) return null;
      const i = state.currentStopIndex;
      if (i < 0 || i >= m.stopLoads.length) return null;
      return `${m.stopLoads[i]}/${state.C}`;
    },
    // Truck marker radius as configured on the live layer — a constant now, so it
    // never varies with load. Lets a test confirm the marker holds one size.
    markerRadius: () => {
      const sel = getSelection();
      const focus = {
        focusedTruck: sel.truckIdx,
        selectedStation: sel.stationIdx,
        stationToTruck: state.stationToTruck,
        hoveredStation: state.hoveredStation,
      };
      return truckMarkerLayer(state.model, state.currentTime, focus).props.getRadius;
    },
    playheadX: () => document.querySelector('#a-load svg .load-playhead')?.getAttribute('x'),
    uiState: () => ({ scrubbing: state.scrubbing, hoveredStation: state.hoveredStation }),
  };
}

boot().catch((err) => {
  console.error(err);
  setLoadingText(`Error: ${err.message}`);
});
