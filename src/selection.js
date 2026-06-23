// The selection spine. ONE shared state that the map, the charts, the legend,
// and focus styling all read from. Selecting a station auto-focuses the truck
// that serves it; focusing a truck (legend) is a selection in its own right.
// Three entry points (map station click, legend truck click, ranking-bar click)
// all funnel through here; everything else just subscribes.

const listeners = new Set();

const state = {
  stationIdx: null, // selected station's dense idx, or null = system default
  truckIdx: null, // focused truck index, or null
};

let stationToTruck = new Map(); // station idx -> truck index (rebuilt each solve)

// Called after every solve so the station→truck mapping stays current. If a
// station is selected, its focused truck is re-derived (assignment may shift).
export function setSolution(routes) {
  stationToTruck = new Map();
  for (const r of routes) for (const s of r.stationIdxs) stationToTruck.set(s, r.truckIndex);
  if (state.stationIdx != null) state.truckIdx = stationToTruck.get(state.stationIdx) ?? null;
  notify();
}

export function selectStation(idx) {
  state.stationIdx = idx;
  state.truckIdx = stationToTruck.get(idx) ?? null; // auto-focus its truck
  notify();
}

// Legend entry point: focus a truck without a specific station selected.
export function focusTruck(truckIdx) {
  state.truckIdx = truckIdx;
  state.stationIdx = null;
  notify();
}

export function clearSelection() {
  if (state.stationIdx == null && state.truckIdx == null) return;
  state.stationIdx = null;
  state.truckIdx = null;
  notify();
}

export function getSelection() {
  return { stationIdx: state.stationIdx, truckIdx: state.truckIdx };
}

export function truckForStation(idx) {
  return stationToTruck.get(idx) ?? null;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const snap = getSelection();
  for (const fn of listeners) fn(snap);
}
