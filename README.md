# Rebalance

Interactive, pure-browser solver + animator for the Citi Bike **rebalancing
problem** — a capacitated pickup-and-delivery VRP with a **mixed fleet**. Route
bike trailers (3 bikes), cargo vans (12), and box trucks (30) to move bikes from
surplus stations to deficit stations in minimum total distance, respecting each
vehicle's capacity. The optimizer is hand-written (no routing/optimization
API); see [`SPEC.md`](./SPEC.md) for the full design and [`CLAUDE.md`](./CLAUDE.md)
for working conventions.

## Status: v1 complete, running on real Citi Bike data

The full loop runs end-to-end:

**DuckDB-Wasm loads Parquet → computes distance matrix → solver worker
(k-means + capacity-aware NN + 2-opt, per-vehicle capacities) → deck.gl renders
stations, route arcs, and animated vehicles → fleet steppers + draggable depot
re-solve live.** A **fleet finder** sweeps every trailer/van/truck mix through
the real solver, prices each plan (fixed dispatch + per-mile, rough estimates),
and recommends the cheapest fleet that serves every station within an 8-hour
overnight shift.

Demand is **real net flow** from one representative NYC weekday (Wed 2025-03-19,
131,576 trips) of the official Citi Bike S3 data — see
[`data/aggregate_demand.py`](./data/aggregate_demand.py). A synthetic generator
([`data/generate_synthetic.mjs`](./data/generate_synthetic.mjs)) writes the same
schema for offline dev without the ~600 MB download.

## Quick start

```bash
npm install
# Real data (one-time, ~600 MB download, cached + gitignored):
uv run --with duckdb --python 3.12 data/aggregate_demand.py
# …or synthetic stand-in (no download):
npm run gen:synthetic
npm run dev             # open the printed localhost URL
```

The map opens on a solved, animating rebalancing — it never loads empty.

## Tests

```bash
node test/solver.test.mjs   # headless solver invariants (capacity, accounting)
node test/coverage.mjs      # solver coverage across K=1..8 on the live parquet
# Browser tests need the dev server running on :5174 (npx vite --port 5174):
node test/smoke.mjs         # full load→solve→animate loop in headless Chrome
node test/interact.mjs      # fleet steppers + depot drag each re-solve
node test/selection.test.mjs# selection state syncs across map + legend + panel
node test/panel.test.mjs    # charts render + ranking-bar is a selection entry point
node test/loadchart.test.mjs# speed control, load profile, playhead sync, scrubber
```

`test/solver.test.mjs` proves the non-negotiables from `SPEC.md`: running load
stays in `[0, cap]` on every route (each vehicle's OWN capacity), no station
served twice, no vehicle visiting a station it can't carry, and bikes-moved
accounting matches served demand — across a grid of K and C plus mixed fleets.

## Architecture

| File | Role |
|---|---|
| `data/aggregate_demand.py` | **Offline.** Real path: S3 trip file → DuckDB net-flow (+ hourly profile) → Parquet. |
| `data/generate_synthetic.mjs` | **Offline.** Synthetic stand-in (same schema, no download). |
| `src/duckdb.js` | DuckDB-Wasm init, Parquet load (+ hourly parse), haversine distance matrix. |
| `src/solver.worker.js` | The optimizer. Cluster-first, capacity-aware NN + 2-opt. The heart of the project. |
| `src/solver.js` | Worker message wrapper (request-id matched). |
| `src/selection.js` | **The selection spine** — one shared state (selected station ⇒ focused truck). |
| `src/layers.js` | deck.gl layers — stations, route arcs, animated trucks; focus-aware styling. |
| `src/charts.js` | Hand-rolled SVG: signed hourly net-flow chart + imbalance ranking. |
| `src/panel.js` | Right-side analytics column (header + chart + ranking), reads selection. |
| `src/ui.js` | Fleet steppers + live metrics panel (incl. cost) + clickable vehicle legend. |
| `src/finder.js` | Fleet finder — sweeps every vehicle mix, prices plans, recommends the cheapest workable fleet. |
| `src/main.js` | Bootstrap: map + deck overlay, orchestrates load → solve → animate + selection. |
| `src/config.js` | Vehicle types (capacity + cost + shift model), colors, marker tuning, map style, defaults. |

Clean boundaries: **DuckDB** loads + measures, **JS** optimizes, **deck.gl**
renders. The solver is dependency-free on purpose.

### Selection spine

One shared state (`src/selection.js`) is the organizing principle: a selected
station auto-focuses the truck that serves it, and that single state drives the
map focus styling, the legend highlight, and the right-side analytics panel
together. Three entry points write it — clicking a station on the map, a truck
in the legend, a bar in the imbalance ranking, or a bar in the load chart — and
everything else just subscribes. When nothing is selected the app shows a
system-level overview, never empty.

### Load inspection (focused truck)

When a truck is focused, the panel shows its **load profile**: x = visit sequence
(depot → stops → depot), y = fixed 0..C with the capacity ceiling drawn as a
reference line, bars colored by pickup (blue) / dropoff (red). The bar heights are
the solver's own per-stop running inventory (`route.waypoints[].load`) — surfaced,
not recomputed — so a blue run climbing to the ceiling then a red run falling reads
as the capacity constraint in action. A global **animation speed** control
(`1× / 0.5× / 0.25×`, default 0.5×) slows the trucks enough to follow; as the
focused truck animates, a **playhead** tracks the current stop in lockstep with its
map position. The chart's x-axis is a **scrubber** — drag to move the truck to any
point on its route (driving map position + playhead together); hover a bar to light
its stop on the map, click to select it via the spine.

### The solver, briefly

1. **Cluster** stations (nonzero demand only) into K groups with k-means on
   lat/lng. **Match** clusters to vehicles (heaviest workload ↔ biggest
   capacity), **evict** any station whose |demand| exceeds its vehicle's
   capacity to the nearest cluster that can carry it (service is atomic — no
   split deliveries), then a **balancing pass** moves boundary stations until
   each cluster's *net* demand trends to ~zero — so one vehicle can actually
   satisfy its cluster. (Each move strictly cuts total imbalance, so it
   converges; moves respect the destination vehicle's capacity.)
2. **Route** each vehicle: capacity-aware nearest-neighbour seed (only steps
   that keep running load in `[0, cap]`), then **2-opt** that rejects any swap
   violating the load profile.
3. Return per-vehicle routes + metrics (total/per-vehicle distance, bikes
   moved, stations satisfied/unsatisfied, max load per vehicle).

Swap the fleet to trailers-only and stations visibly strand (a +18 surplus
needs a vehicle that can carry ≥18); add a box truck and routes relax. That
honest dynamic range is the proof the capacity constraint is real. Dollar costs
and the shift clock live **outside** the solver (`config.js`): the solver
minimizes distance for a given fleet; the finder judges fleets by price and
drivability.

## Synthetic data

`generate_synthetic.mjs` builds 140 Manhattan-ish stations whose demand comes
from scattered **commute hotspots** (a transit hub fills while nearby
residential blocks empty), interspersed across the city and then adjusted so the
system **nets to exactly zero** (the solvability invariant). This mimics the
interleaved surplus/deficit of real trip flows — and, unlike a single
downtown→uptown gradient, it lets geographic truck clusters naturally contain
both pickups and dropoffs.

Schema (identical to the real output):

```
station_id VARCHAR · name VARCHAR · lat DOUBLE · lng DOUBLE · capacity INT · demand INT
```

## Real data pipeline

`data/aggregate_demand.py` (offline, re-runnable) does it all in DuckDB:

1. Verifies the exact NYC filename against the live S3 listing (naming/extension
   vary by era), refuses `JC` (Jersey City) files, downloads + unzips to a
   gitignored cache.
2. **Fails loudly** if the CSV header isn't the modern post-2020 schema.
3. Filters to one weekday, computes per-station **net flow = (rides ending) −
   (rides starting)**, takes median coords per station (GPS-robust), keeps the
   busiest ~250 inside the Manhattan view box, scales/clips demand to a
   slider-friendly range, and nudges the set to **net exactly zero** (solvable).
4. Writes `public/stations_demand.parquet` — the same schema the app already loads.

```bash
uv run --with duckdb --python 3.12 data/aggregate_demand.py \
    --month 202503 --date 2025-03-19 --top 250
```

`capacity` is a placeholder column (real dock capacity isn't in the trip feed;
the solver ignores it). The raw monthly file is never committed and never loaded
in the browser. Coverage on this data: all 228 imbalanced stations are served at
the default K=4 / C=30; tightening C below ~24 strands the busiest hubs.

## Phase 2 (not started — keep separate)

Road-following geometry for *drawing* final routes only (optimizer stays on
great-circle), click-a-station to perturb demand, CSV/GeoJSON upload.
