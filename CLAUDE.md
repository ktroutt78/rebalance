# CLAUDE.md

Operating guidance for working on **Rebalance**. Read `SPEC.md` for the full design; this file is the short, durable "how to work here" reference.

## What this project is

A pure-browser app that solves and animates the Citi Bike **rebalancing problem** (capacitated pickup-and-delivery VRP): route a fleet of trucks to move bikes from surplus stations to deficit stations in minimum total distance, respecting truck capacity. Portfolio piece. Real station data, real demand from real trip flows, **hand-written optimizer**.

## Non-negotiable constraints

- **No optimization/routing API may solve the problem.** The solver is written from scratch. A road-directions API is allowed in **phase 2 only**, and **only to draw final route geometry** — never to decide assignment or order. If a task drifts toward calling an API to optimize, stop and flag it.
- **Pure web, no backend.** Only a small pre-aggregated Parquet ships to the client. Never load raw Citi Bike trip files in the browser.
- **Solver runs in a Web Worker** so the UI never blocks during 2-opt.
- **Data source is official Citi Bike S3** (NYC files, not `JC`-prefixed). Demand = real net flow over one representative weekday. Don't substitute a Kaggle mirror without flagging it.

## Build order — respect the phases

Build **v1 core fully before touching phase 2.** Don't scaffold phase-2 features early "to save time" — it dilutes the core.
- **v1:** DuckDB-Wasm load + distance matrix, capacity-aware solver (NN + 2-opt) in a worker, MapLibre + deck.gl stations/route arcs, K & C sliders, draggable depot, live metrics, animated trucks.
- **Phase 2 (only after v1 works):** road-following final geometry (draw-only), click-to-perturb demand, CSV/GeoJSON upload.

## Architecture quick map

- `data/aggregate_demand.py` — offline, one-time: S3 trip file → DuckDB → `stations_demand.parquet`. Not part of the runtime app.
- `src/duckdb.js` — DuckDB-Wasm init, Parquet load, `ST_Distance` matrix.
- `src/solver.worker.js` — the optimizer. The heart of the project. Keep it readable; it's interview material.
- `src/solver.js` — worker message wrapper.
- `src/layers.js` — deck.gl layers (stations, arcs, TripsLayer).
- `src/ui.js` — sliders, depot drag, metrics panel.
- `src/config.js` — K/C ranges, colors, map style, bbox, default load state.

## Conventions

- Vanilla JS modules unless there's a real reason to add a framework; this is a focused single-view app.
- Keep the solver dependency-free (no optimization libraries) — that's the point.
- DuckDB does data work (loading, distance matrix, aggregation); JS does optimization; deck.gl does rendering. Keep those boundaries clean.
- Distances are great-circle/haversine in v1. Route arcs are geodesic — they honestly represent what's optimized.
- The map must never load empty: open on a solved, animating initial state.

## Solver correctness reminders

- Running truck load must always stay in `[0, C]` — both the NN seed and every accepted 2-opt swap must preserve this.
- Demand should net to ~zero system-wide (enforced during aggregation) so the problem is solvable.
- Always surface metrics: total + per-truck distance, bikes moved, stations satisfied/unsatisfied, max load per truck. These are the proof the optimizer works.

## When unsure

Check `SPEC.md` section 9 (locked decisions) and section 10 (open items). If a decision isn't covered in either, flag it rather than guessing — especially anything touching the no-API boundary or the v1/phase-2 line.
