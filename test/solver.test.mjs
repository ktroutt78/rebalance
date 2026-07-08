// Headless correctness harness for the solver worker. Polyfills the worker
// globals (self/performance), feeds a synthetic problem, and asserts the
// capacity invariant + accounting that the SPEC calls the "proof it works".
//
// Run:  node test/solver.test.mjs

import { performance } from 'node:perf_hooks';

// --- polyfill the Web Worker surface the module expects ---
let captured = null;
globalThis.self = globalThis;
globalThis.performance = performance;
globalThis.postMessage = (msg) => {
  captured = msg;
};

await import('../src/solver.worker.js');

// --- build a synthetic, net-zero problem ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);

const N = 120;
const stations = [];
for (let i = 0; i < N; i++) {
  const lat = 40.70 + rand() * 0.1;
  const lng = -74.01 + rand() * 0.08;
  let demand = Math.round((rand() - 0.5) * 28);
  stations.push({ idx: i, lat, lng, demand });
}
// force exact net zero
let net = stations.reduce((s, st) => s + st.demand, 0);
while (net !== 0) {
  const st = stations[Math.floor(rand() * N)];
  const dir = net > 0 ? -1 : 1;
  if (Math.abs(st.demand + dir) <= 20) {
    st.demand += dir;
    net += dir;
  }
}

const R = 6371000;
const hav = (a, b) => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
};
const matrix = new Float64Array(N * N);
for (let i = 0; i < N; i++)
  for (let j = 0; j < N; j++) matrix[i * N + j] = hav(stations[i], stations[j]);

const depot = { lat: 40.735, lng: -73.99 };
const demandById = new Map(stations.map((s) => [s.idx, s.demand]));

// --- run solve across a matrix of K and C, checking invariants ---
let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error('  ✗', msg);
    failures++;
  }
};

self.onmessage({ data: { type: 'init', payload: { stations, matrix } } });

for (const K of [1, 2, 4, 6, 8]) {
  for (const C of [10, 20, 40, 80]) {
    self.onmessage({ data: { type: 'solve', payload: { depot, K, C } } });
    const { routes, metrics } = captured.payload;

    // (1) capacity invariant: replay every route's load profile.
    let servedBikes = 0;
    for (const r of routes) {
      let load = 0;
      for (const id of r.stationIdxs) {
        load += demandById.get(id);
        assert(load >= -1e-9 && load <= C + 1e-9, `K=${K} C=${C} truck ${r.truckIndex} load ${load} out of [0,${C}]`);
        servedBikes += Math.abs(demandById.get(id));
      }
    }

    // (2) accounting: bikes moved matches served demand magnitudes.
    assert(metrics.bikesMoved === servedBikes, `K=${K} C=${C} bikesMoved ${metrics.bikesMoved} != ${servedBikes}`);

    // (3) no station double-served; satisfied + unsatisfied accounted.
    const seen = new Set();
    for (const r of routes) for (const id of r.stationIdxs) {
      assert(!seen.has(id), `K=${K} C=${C} station ${id} served twice`);
      seen.add(id);
    }

    // (4) trucks count == K (empty routes allowed but present).
    assert(routes.length === Math.min(K, N), `K=${K} produced ${routes.length} routes`);

    const demanders = stations.filter((s) => s.demand !== 0).length;
    const pct = ((metrics.satisfied / demanders) * 100).toFixed(0);
    console.log(
      `K=${K} C=${String(C).padStart(2)} → dist ${(metrics.totalDistance / 1000).toFixed(1)}km  served ${metrics.satisfied}/${demanders} (${pct}%)  unsat ${metrics.unsatisfied}  moved ${metrics.bikesMoved}  ${captured.payload.solveMs}ms`
    );
  }
}

// --- mixed fleet: per-vehicle capacities ---
console.log('\nmixed fleets:');
const FLEETS = [
  [30, 30, 12, 3], // default-ish mix
  [30, 12, 12, 3, 3],
  [3, 3, 3, 3], // trailers only — big stations must be reported unserved
  [12, 3],
  [30],
];
for (const fleet of FLEETS) {
  self.onmessage({ data: { type: 'solve', payload: { depot, fleet } } });
  const { routes, metrics, unsatisfiedIdxs } = captured.payload;
  const tag = `fleet=[${fleet}]`;

  // (5) one route per vehicle, tagged with its own capacity.
  assert(routes.length === fleet.length, `${tag} produced ${routes.length} routes`);
  for (const t of metrics.perTruck) {
    assert(t.capacity === fleet[t.truckIndex], `${tag} truck ${t.truckIndex} capacity ${t.capacity} != ${fleet[t.truckIndex]}`);
  }

  // (6) capacity invariant against each vehicle's OWN capacity, and no vehicle
  // visits a station whose |demand| it can't carry (service is atomic).
  const seen = new Set();
  for (const r of routes) {
    const cap = fleet[r.truckIndex];
    let load = 0;
    for (const id of r.stationIdxs) {
      const d = demandById.get(id);
      assert(Math.abs(d) <= cap, `${tag} truck ${r.truckIndex} (cap ${cap}) visits station ${id} with |demand| ${Math.abs(d)}`);
      load += d;
      assert(load >= -1e-9 && load <= cap + 1e-9, `${tag} truck ${r.truckIndex} load ${load} out of [0,${cap}]`);
      assert(!seen.has(id), `${tag} station ${id} served twice`);
      seen.add(id);
    }
  }

  // (7) coverage accounting: served + unserved partitions the demanders, and
  // every station too big for the whole fleet is reported unserved.
  const maxCap = Math.max(...fleet);
  const demanders = stations.filter((s) => s.demand !== 0);
  assert(
    metrics.satisfied + metrics.unsatisfied === demanders.length,
    `${tag} served ${metrics.satisfied} + unserved ${metrics.unsatisfied} != ${demanders.length}`
  );
  const unsetSet = new Set(unsatisfiedIdxs);
  for (const s of demanders) {
    if (Math.abs(s.demand) > maxCap) {
      assert(unsetSet.has(s.idx), `${tag} station ${s.idx} (|demand| ${Math.abs(s.demand)} > max cap ${maxCap}) not reported unserved`);
    }
  }

  console.log(
    `${tag.padEnd(22)} → dist ${(metrics.totalDistance / 1000).toFixed(1)}km  served ${metrics.satisfied}/${demanders.length}  unsat ${metrics.unsatisfied}  moved ${metrics.bikesMoved}`
  );
}

// (8) legacy {K, C} equals an explicit homogeneous fleet.
self.onmessage({ data: { type: 'solve', payload: { depot, K: 4, C: 30 } } });
const legacy = captured.payload;
self.onmessage({ data: { type: 'solve', payload: { depot, fleet: [30, 30, 30, 30] } } });
const explicit = captured.payload;
assert(
  legacy.metrics.totalDistance === explicit.metrics.totalDistance &&
    legacy.metrics.satisfied === explicit.metrics.satisfied,
  `legacy K/C solve differs from explicit homogeneous fleet`
);

console.log(failures === 0 ? '\n✓ all invariants hold' : `\n✗ ${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
