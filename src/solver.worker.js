// ─────────────────────────────────────────────────────────────────────────
// The optimizer. Interview material — read top to bottom.
//
// Problem: capacitated 1-commodity pickup-and-delivery VRP, with a
// HETEROGENEOUS fleet.
//   Each station has signed demand: +N = surplus (vehicle PICKS UP N bikes),
//   −N = deficit (vehicle DROPS OFF N). Vehicle t starts empty at the depot,
//   and its running load must stay in [0, caps[t]] at EVERY stop (can't carry
//   more than its own capacity, can't drop bikes it doesn't have). A station
//   is served atomically — no split deliveries — so a vehicle can only visit
//   stations whose |demand| fits its capacity. Minimize total fleet distance.
//
// Strategy: cluster-first, route-second, capacity-aware. All hand-written —
// no optimization library. (CLAUDE.md: that's the whole point.)
//   1. k-means on lat/lng → K spatial clusters, matched to vehicles biggest-
//      capacity ↔ heaviest-workload; stations too big for their vehicle are
//      evicted to the nearest cluster whose vehicle can carry them; then a
//      balancing pass nudges each cluster's NET demand toward zero (so one
//      vehicle can satisfy its cluster without stranding pickups/dropoffs).
//   2. Per vehicle: capacity-aware nearest-neighbour seed, then 2-opt cleanup
//      that REJECTS any swap violating the load profile.
//
// The matrix + stations are sent once via {type:'init'}; each {type:'solve'}
// only carries depot + fleet so dragging the depot or nudging a control is
// cheap. `fleet` is an array of per-vehicle capacities; the legacy {K, C}
// form (K identical vehicles) is still accepted.
// ─────────────────────────────────────────────────────────────────────────

let STATIONS = null; // [{idx, lat, lng, demand}]
let MATRIX = null; // Float64Array, station-station haversine metres, dist[i*n+j]
let N = 0;

self.onmessage = (e) => {
  const { type, payload } = e.data;
  if (type === 'init') {
    STATIONS = payload.stations;
    MATRIX = payload.matrix;
    N = STATIONS.length;
    return;
  }
  if (type === 'solve') {
    const t0 = performance.now();
    // fleet = per-vehicle capacity list; {K, C} = legacy homogeneous form.
    const caps = payload.fleet ?? new Array(payload.K).fill(payload.C);
    const result = solve(payload.depot, caps);
    result.solveMs = Math.round(performance.now() - t0);
    self.postMessage({ type: 'solved', payload: result, id: e.data.id });
  }
};

// ── distance helpers ──────────────────────────────────────────────────────
const R = 6371000; // earth radius, metres
function haversine(aLat, aLng, bLat, bLng) {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180;
  const lb = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// ── main solve ────────────────────────────────────────────────────────────
function solve(depot, caps) {
  const K = caps.length;
  // Depot moves at runtime, so its distances are computed here (the O(N²)
  // station-station block stays cached in MATRIX from DuckDB).
  const depotDist = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    depotDist[i] = haversine(depot.lat, depot.lng, STATIONS[i].lat, STATIONS[i].lng);
  }

  // Only stations with nonzero demand are part of the VRP — a balanced dock
  // needs no visit, and routing to it would just burn distance.
  const active = [];
  for (let i = 0; i < N; i++) if (STATIONS[i].demand !== 0) active.push(i);

  const clusters = clusterStations(K, active);
  const byVehicle = matchClustersToVehicles(clusters, caps);
  const unserviceable = evictOversized(byVehicle, caps, depotDist);
  balanceClusters(byVehicle, caps);

  const routes = [];
  const allUnsatisfied = [...unserviceable];
  for (let t = 0; t < K; t++) {
    const seedIdxs = byVehicle[t];
    if (seedIdxs.length === 0) {
      routes.push(emptyRoute(t, depot));
      continue;
    }
    const { order, unsatisfied } = nearestNeighbourRoute(seedIdxs, depotDist, caps[t]);
    const optimized = twoOpt(order, depotDist, caps[t]);
    allUnsatisfied.push(...unsatisfied);
    routes.push(buildRoute(t, optimized, depot, depotDist));
  }

  return assembleMetrics(routes, allUnsatisfied, caps);
}

// ── 1a′. cluster ↔ vehicle matching ───────────────────────────────────────
// k-means is capacity-blind, so decide WHO drives WHERE afterwards: rank
// clusters by workload (Σ|demand| — bikes that must cross its docks) and hand
// the heaviest cluster to the biggest vehicle. With fewer clusters than
// vehicles (sparse problems), the smallest vehicles are the ones left parked.
function matchClustersToVehicles(clusters, caps) {
  const K = caps.length;
  const workload = (members) => members.reduce((s, i) => s + Math.abs(STATIONS[i].demand), 0);
  const clusterOrder = clusters
    .map((_, c) => c)
    .sort((a, b) => workload(clusters[b]) - workload(clusters[a]));
  const vehicleOrder = caps.map((_, t) => t).sort((a, b) => caps[b] - caps[a] || a - b);

  const byVehicle = Array.from({ length: K }, () => []);
  clusterOrder.forEach((c, rank) => {
    byVehicle[vehicleOrder[rank]] = clusters[c];
  });
  return byVehicle;
}

// ── 1a″. oversized-station eviction ───────────────────────────────────────
// A station is served atomically, so a vehicle can never visit one whose
// |demand| exceeds its capacity (the load would leave [0, cap] in one step).
// Rather than letting those strand in a small vehicle's cluster, move each to
// the nearest cluster whose vehicle CAN carry it. A station too big for the
// whole fleet is unserviceable — reported unserved up front.
function evictOversized(byVehicle, caps, depotDist) {
  const K = caps.length;
  const unserviceable = [];
  const centroidOf = (members) => {
    let lat = 0;
    let lng = 0;
    for (const i of members) {
      lat += STATIONS[i].lat;
      lng += STATIONS[i].lng;
    }
    return { lat: lat / members.length, lng: lng / members.length };
  };

  for (let t = 0; t < K; t++) {
    const keep = [];
    for (const i of byVehicle[t]) {
      const need = Math.abs(STATIONS[i].demand);
      if (need <= caps[t]) {
        keep.push(i);
        continue;
      }
      // nearest capable cluster; an empty capable cluster competes at its
      // depot distance (its vehicle would start the route from the depot).
      let best = -1;
      let bestD = Infinity;
      for (let u = 0; u < K; u++) {
        if (u === t || caps[u] < need) continue;
        const d = byVehicle[u].length
          ? sqDist(STATIONS[i], centroidOf(byVehicle[u]))
          : (depotDist[i] / 111000) ** 2; // metres → rough degrees² to compare with sqDist
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      if (best < 0) unserviceable.push(i);
      else byVehicle[best].push(i);
    }
    byVehicle[t] = keep;
  }
  return unserviceable;
}

// ── 1a. k-means clustering on lat/lng (over the active stations only) ──────
function clusterStations(K, active) {
  const k = Math.min(K, active.length);
  if (k === 0) return [];
  // k-means++ seeding for spread-out initial centroids.
  const centroids = kmeansPlusPlusSeeds(k, active);
  const assign = new Map(); // station idx -> cluster

  for (let iter = 0; iter < 40; iter++) {
    let moved = false;
    // assignment step
    for (const i of active) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(STATIONS[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign.get(i) !== best) {
        assign.set(i, best);
        moved = true;
      }
    }
    // update step
    const sumLat = new Float64Array(k);
    const sumLng = new Float64Array(k);
    const count = new Int32Array(k);
    for (const i of active) {
      const c = assign.get(i);
      sumLat[c] += STATIONS[i].lat;
      sumLng[c] += STATIONS[i].lng;
      count[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (count[c] > 0) {
        centroids[c] = { lat: sumLat[c] / count[c], lng: sumLng[c] / count[c] };
      }
    }
    if (!moved && iter > 0) break;
  }

  const clusters = Array.from({ length: k }, () => []);
  for (const i of active) clusters[assign.get(i)].push(i);
  return clusters;
}

function kmeansPlusPlusSeeds(k, active) {
  const seeds = [];
  // deterministic first seed: the active station nearest the data centroid
  let cLat = 0;
  let cLng = 0;
  for (const i of active) {
    cLat += STATIONS[i].lat;
    cLng += STATIONS[i].lng;
  }
  cLat /= active.length;
  cLng /= active.length;
  let firstIdx = active[0];
  let firstD = Infinity;
  for (const i of active) {
    const d = sqDist(STATIONS[i], { lat: cLat, lng: cLng });
    if (d < firstD) {
      firstD = d;
      firstIdx = i;
    }
  }
  seeds.push({ lat: STATIONS[firstIdx].lat, lng: STATIONS[firstIdx].lng });

  // remaining seeds: farthest-from-existing (deterministic k-means++ argmax)
  while (seeds.length < k) {
    let pick = active[0];
    let pickD = -1;
    for (const i of active) {
      let nearest = Infinity;
      for (const s of seeds) nearest = Math.min(nearest, sqDist(STATIONS[i], s));
      if (nearest > pickD) {
        pickD = nearest;
        pick = i;
      }
    }
    seeds.push({ lat: STATIONS[pick].lat, lng: STATIONS[pick].lng });
  }
  return seeds;
}

// Planar squared distance — fine for clustering at city scale.
function sqDist(a, b) {
  const dx = a.lat - b.lat;
  const dy = (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180);
  return dx * dx + dy * dy;
}

// ── 1b. balancing pass: drive each cluster's net demand toward zero ────────
// A spatially tidy cluster that is all surplus (or all deficit) can't be
// served by a single truck. We greedily move boundary stations to a
// neighbouring cluster while it reduces the global imbalance Σ|net_c|.
// With a mixed fleet the move must also respect the destination vehicle: a
// station never moves to a cluster whose vehicle can't carry its |demand|.
function balanceClusters(clusters, caps) {
  const k = clusters.length;
  if (k < 2) return;

  const centroidOf = (members) => {
    let lat = 0;
    let lng = 0;
    for (const i of members) {
      lat += STATIONS[i].lat;
      lng += STATIONS[i].lng;
    }
    return { lat: lat / members.length, lng: lng / members.length };
  };
  const netOf = (members) => members.reduce((s, i) => s + STATIONS[i].demand, 0);

  // Each accepted move strictly reduces the integer Σ|net|, so this terminates;
  // the loop cap is just a backstop.
  for (let pass = 0; pass < 4 * N + 50; pass++) {
    const nets = clusters.map(netOf);
    const totalImbalance = nets.reduce((s, v) => s + Math.abs(v), 0);
    if (totalImbalance === 0) break;

    const centroids = clusters.map((m) => (m.length ? centroidOf(m) : null));

    // Best single move (station i : from → to) that most reduces Σ|net|.
    // Crucially we consider EVERY destination cluster, not just the nearest —
    // the cluster that should absorb a surplus station is whichever is most
    // in deficit, which is often not the closest. Spatial proximity is only a
    // tie-breaker, so balance (feasibility) wins but routes stay as tight as
    // the imbalance allows.
    let best = null;
    for (let from = 0; from < k; from++) {
      if (nets[from] === 0 || clusters[from].length <= 1) continue;
      const sign = Math.sign(nets[from]); // shed stations of this sign
      for (const i of clusters[from]) {
        const d = STATIONS[i].demand;
        if (Math.sign(d) !== sign) continue; // moving this reduces |net_from|
        for (let to = 0; to < k; to++) {
          if (to === from || !centroids[to]) continue;
          if (Math.abs(d) > caps[to]) continue; // destination vehicle can't carry it
          const before = Math.abs(nets[from]) + Math.abs(nets[to]);
          const after = Math.abs(nets[from] - d) + Math.abs(nets[to] + d);
          const gain = before - after; // >0 ⇒ global imbalance reduced
          if (gain <= 0) continue;
          const spatial = sqDist(STATIONS[i], centroids[to]); // tie-break: nearer is better
          // primary: maximize gain; secondary: minimize destination distance
          const score = gain * 1e9 - spatial;
          if (!best || score > best.score) best = { from, to, i, score };
        }
      }
    }

    if (!best) break; // no improving move — converged
    clusters[best.from] = clusters[best.from].filter((x) => x !== best.i);
    clusters[best.to].push(best.i);
  }
}

// ── 2a. capacity-aware nearest-neighbour seed ─────────────────────────────
// From the current position, go to the nearest station whose visit keeps the
// running load within [0, C]. Empty truck ⇒ first stop must be a pickup.
function nearestNeighbourRoute(seedIdxs, depotDist, C) {
  const unvisited = new Set(seedIdxs);
  const order = [];
  let load = 0;
  let cur = -1; // -1 ⇒ at depot

  while (unvisited.size > 0) {
    let best = -1;
    let bestD = Infinity;
    for (const s of unvisited) {
      const next = load + STATIONS[s].demand;
      if (next < 0 || next > C) continue; // capacity-infeasible right now
      const d = cur < 0 ? depotDist[s] : MATRIX[cur * N + s];
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best < 0) break; // nothing feasible — remainder stranded (cluster imbalance)
    order.push(best);
    load += STATIONS[best].demand;
    unvisited.delete(best);
    cur = best;
  }
  return { order, unsatisfied: [...unvisited] };
}

// ── 2b. 2-opt with capacity-profile rejection ─────────────────────────────
// Standard 2-opt over a path with fixed depot endpoints. A reversal is
// accepted only if it (a) shortens the route AND (b) keeps load in [0, C].
function twoOpt(order, depotDist, C) {
  const m = order.length;
  if (m < 3) return order;

  // edge length between path positions; position -1 and m denote the depot.
  const edge = (posA, posB) => {
    const a = posA < 0 || posA >= m ? -1 : order[posA];
    const b = posB < 0 || posB >= m ? -1 : order[posB];
    if (a < 0 && b < 0) return 0;
    if (a < 0) return depotDist[b];
    if (b < 0) return depotDist[a];
    return MATRIX[a * N + b];
  };

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 0; i < m - 1; i++) {
      for (let k = i + 1; k < m; k++) {
        // reversing order[i..k] swaps edges (i-1,i)+(k,k+1) for (i-1,k)+(i,k+1)
        const before = edge(i - 1, i) + edge(k, k + 1);
        const after = edge(i - 1, k) + edge(i, k + 1);
        if (after - before < -1e-6 && reversedStaysFeasible(order, i, k, C)) {
          reverseInPlace(order, i, k);
          improved = true;
        }
      }
    }
  }
  return order;
}

// Would reversing order[i..k] keep the whole-route load profile within [0, C]?
function reversedStaysFeasible(order, i, k, C) {
  let load = 0;
  for (let p = 0; p < order.length; p++) {
    // walk the route as if [i..k] were reversed
    let idx;
    if (p < i || p > k) idx = order[p];
    else idx = order[k - (p - i)];
    load += STATIONS[idx].demand;
    if (load < 0 || load > C) return false;
  }
  return true;
}

function reverseInPlace(arr, i, k) {
  while (i < k) {
    const tmp = arr[i];
    arr[i] = arr[k];
    arr[k] = tmp;
    i++;
    k--;
  }
}

// ── route + metrics assembly ──────────────────────────────────────────────
function buildRoute(truckIndex, order, depot, depotDist) {
  // waypoints: depot → stations → depot, with running load + cumulative distance
  const waypoints = [{ lng: depot.lng, lat: depot.lat, load: 0, station: null }];
  let load = 0;
  let dist = 0;
  let prev = -1;
  let maxLoad = 0;
  let bikesMoved = 0;

  for (const s of order) {
    dist += prev < 0 ? depotDist[s] : MATRIX[prev * N + s];
    load += STATIONS[s].demand;
    maxLoad = Math.max(maxLoad, load);
    bikesMoved += Math.abs(STATIONS[s].demand);
    waypoints.push({
      lng: STATIONS[s].lng,
      lat: STATIONS[s].lat,
      load,
      station: STATIONS[s].idx,
    });
    prev = s;
  }
  if (order.length > 0) {
    dist += depotDist[order[order.length - 1]];
  }
  waypoints.push({ lng: depot.lng, lat: depot.lat, load: 0, station: null });

  return {
    truckIndex,
    stationIdxs: order.map((s) => STATIONS[s].idx),
    waypoints,
    distance: dist,
    maxLoad,
    bikesMoved,
  };
}

function emptyRoute(truckIndex, depot) {
  return {
    truckIndex,
    stationIdxs: [],
    waypoints: [{ lng: depot.lng, lat: depot.lat, load: 0, station: null }],
    distance: 0,
    maxLoad: 0,
    bikesMoved: 0,
  };
}

function assembleMetrics(routes, unsatisfied, caps) {
  const totalDistance = routes.reduce((s, r) => s + r.distance, 0);
  const bikesMoved = routes.reduce((s, r) => s + r.bikesMoved, 0);
  const servedStations = routes.reduce((s, r) => s + r.stationIdxs.length, 0);
  const totalStations = N;
  const demanding = STATIONS.filter((s) => s.demand !== 0).length;

  return {
    routes,
    unsatisfiedIdxs: unsatisfied,
    metrics: {
      totalDistance,
      bikesMoved,
      satisfied: servedStations,
      unsatisfied: unsatisfied.length,
      totalStations,
      demandingStations: demanding,
      capacity: Math.max(...caps), // legacy scalar; per-vehicle truth is below
      fleet: [...caps],
      perTruck: routes.map((r) => ({
        truckIndex: r.truckIndex,
        capacity: caps[r.truckIndex],
        distance: r.distance,
        stops: r.stationIdxs.length,
        maxLoad: r.maxLoad,
        bikesMoved: r.bikesMoved,
      })),
    },
  };
}
