# Rebalance — Interactive Bike-Share Rebalancing VRP

**Planning spec / source of truth for Claude Code build.**
A pure-browser application that solves and animates the Citi Bike *rebalancing problem*: route a small fleet of trucks to move bikes from over-full stations to empty ones, in minimum total distance, respecting truck capacity. Real station data, real demand derived from real trip flows, optimizer written from scratch (no optimization API).

---

## 1. The problem

Each bike-share station has a signed **demand**:
- **Surplus** (`+N`): too many bikes, truck must *pick up* N.
- **Deficit** (`−N`): too few bikes, truck must *drop off* N.

A fleet of **K trucks**, each with **capacity C**, starts at a **depot**, drives a route doing pickups and drop-offs, and returns to the depot. Constraints:
- Running truck load must always stay within `[0, C]` — can't carry more than C, can't drop bikes it doesn't have.
- Every station's demand should be satisfied.
- System demand is constructed to net to ~zero (total surplus ≈ total deficit) so the problem is solvable.

**Objective:** minimize total fleet distance.

This is a **capacitated pickup-and-delivery VRP**. The capacity constraint is physically motivated (a truck literally can't carry more than C bikes), which is what makes routing non-trivial.

---

## 2. Stack (pure web, no backend)

| Layer | Tool | Role |
|---|---|---|
| Data engine | **DuckDB-Wasm** | Load station Parquet, compute distance matrix, spatial filtering |
| Base map | **MapLibre GL** | Map, pan/zoom, click interaction |
| Route/animation layer | **deck.gl** | Color-coded routes + animated `TripsLayer` trucks |
| Solver | **Plain JS in a Web Worker** | Capacity-aware NN + 2-opt; keeps UI responsive |

No optimization API is used. Optionally a road-directions API is used **only to draw final route geometry** (phase 2) — never to optimize.

---

## 3. Data pipeline

### Source (canonical)
- **Official Citi Bike trip data** from their public S3: monthly CSV/CSV-zip files (`https://s3.amazonaws.com/tripdata/`). Files NOT prefixed `JC` = NYC; `JC` = Jersey City. Use NYC.
- Reproducible, no Kaggle-mirror drift.

### Demand derivation
- **Window: a single representative weekday** (cleanest commuter surplus/deficit signal; smoother month-averaging loses the drama). Pick one normal mid-week non-holiday day.
- Per station, **net flow = (rides ending there) − (rides starting there)** over the window. Positive net = bikes accumulate = **surplus**; negative = **deficit**.
- This is the headline flex: demand is *real operational imbalance from real rides*, not invented.

### Pre-aggregation (offline, one-time — itself a DuckDB showcase)
1. Pull one weekday's trip file from S3.
2. In DuckDB: parse, filter to the day, aggregate start/end counts per station id, join to station lat/lng, compute net flow → demand.
3. Optionally scale/clip demand to a sane range for truck capacities.
4. **Adjust so total nets to ~zero** (distribute any residual) so it's solvable.
5. Write a **small per-station Parquet** (~few hundred rows): `station_id, name, lat, lng, capacity, demand`.

### Runtime load
- App loads ONLY the small per-station Parquet into DuckDB-Wasm (fast). Never loads raw trip files in-browser.
- DuckDB computes the pairwise distance matrix at runtime via an `ST_Distance` cross join (great-circle / haversine).

---

## 4. Solver design (in Web Worker)

**Cluster-first, route-second, capacity-aware.** All hand-written.

1. **Assign** stations to K trucks. Cluster spatially (k-means on lat/lng), with a balancing nudge so each truck's *net* pickup/dropoff trends toward zero (a truck shouldn't be assigned 200 surplus and no deficits).
2. **Route each truck** independently:
   - **Capacity-aware nearest-neighbor** seed: from current position, choose the nearest *feasible* next stop — feasible = picking it up/dropping it keeps running load within `[0, C]`.
   - **2-opt** cleanup: standard 2-opt, but **reject any swap that violates the capacity profile** along the route.
3. Return per-truck ordered routes + metrics.

**Metrics returned:** total distance, per-truck distance, bikes moved, stations satisfied / unsatisfied, max load reached per truck.

Honest, explainable, fast for a few hundred stations. Not claimed to be optimal — it's a well-known heuristic family, which is the correct portfolio framing.

---

## 5. Interaction model

- **Load state:** map opens with stations plotted (color/size by surplus vs deficit) and an initial solved rebalancing already animating. **Never show an empty map.**
- **K slider** (trucks, ~1–8): re-solve + re-animate live.
- **C slider** (truck capacity): re-solve live; watch routes reshape as capacity tightens/loosens.
- **Depot:** draggable; re-solve on drop.
- **Live readout panel:** total distance, bikes moved, per-truck distance, stations satisfied.
- **Truck animation:** deck.gl `TripsLayer`; encode current load in truck color/size so trucks visibly fill and empty as they move.

---

## 6. Visual design notes

- Manhattan frames well — island shape, rivers, dense dock grid. Keep water/land contrast strong in the MapLibre style.
- Stations: diverging color scale (surplus one hue, deficit another), size ∝ |demand|.
- Routes: one distinct color per truck.
- Route lines: **straight/geodesic arcs** in v1 (honest — we optimize on great-circle distance, so arcs faithfully represent what's optimized). Slight arc curvature reads as deliberate design.

---

## 7. Build order (phases)

### v1 — core (build this first, fully)
- DuckDB-Wasm loads per-station Parquet.
- Distance matrix via `ST_Distance`.
- Capacitated pickup-delivery solver in a Web Worker (NN + capacity-aware 2-opt).
- MapLibre base + deck.gl stations and route arcs.
- K and C sliders, draggable depot, live metrics readout.
- Animated trucks (TripsLayer) with load encoded in appearance.
- Pre-aggregated demand Parquet from one real weekday (offline DuckDB script committed to repo).

### Phase 2 — enhancements (clearly separate; don't let these block v1)
- **Road-following route geometry for the final drawn routes only** (OSRM/Mapbox directions, a handful of calls — one per truck — well within free tiers). Optimizer still runs on straight-line distance and stays fully ours. Reintroduces a small API dependency; keep optional.
- **Click-a-station to perturb its demand** and re-solve.
- CSV/GeoJSON upload to run on arbitrary station sets.

---

## 8. Suggested repo structure

```
/data
  aggregate_demand.py        # offline: S3 trip file -> DuckDB -> per-station Parquet
  stations_demand.parquet    # committed output (small)
/src
  main.js                    # app bootstrap, map + deck.gl setup
  duckdb.js                  # DuckDB-Wasm init, parquet load, distance matrix
  solver.worker.js           # capacitated PDVRP solver (NN + 2-opt)
  solver.js                  # worker wrapper / message API
  layers.js                  # deck.gl layers (stations, route arcs, trips)
  ui.js                      # sliders, depot drag, metrics panel
  config.js                  # constants (K/C ranges, colors, map style, bbox)
index.html
README.md
```

---

## 9. Key decisions already locked

- **Problem:** capacitated pickup-and-delivery VRP (bike rebalancing), not plain TSP/VRP.
- **Data source:** official Citi Bike S3 monthly trip data (NYC, non-`JC`).
- **Demand:** real net-flow over a single representative weekday.
- **No optimization API** — solver is hand-written. (Road API allowed in phase 2 for *drawing only*.)
- **Pure web** — no backend; only a small Parquet ships to the client.
- **Solver:** cluster-first, capacity-aware NN + 2-opt, in a Web Worker.

---

## 10. Open items to resolve during build

- Pick the exact weekday/month file from S3 (a normal mid-week, non-holiday day).
- Sanity-check demand magnitudes vs. chosen capacity range so the sliders have a satisfying dynamic range.
- Decide default K and C landing values for the initial load state.
