// DuckDB-Wasm: init, load the per-station Parquet, compute the pairwise
// distance matrix. This is the ONLY place data work happens — JS optimizes,
// deck.gl renders, DuckDB loads + measures. Keep that boundary clean.

import * as duckdb from '@duckdb/duckdb-wasm';
import { PARQUET_URL } from './config.js';

let _db = null;
let _conn = null;

// Spin up DuckDB-Wasm from the jsDelivr-hosted bundle (picks the right
// build — mvp vs eh — for the browser automatically).
async function initDuckDB() {
  if (_conn) return _conn;
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  _db = db;
  _conn = await db.connect();
  return _conn;
}

// Defensive parse: the hourly column is a JSON 24-array string. Always return a
// length-24 number array so chart code never has to guard.
function parseHourly(raw) {
  try {
    const arr = JSON.parse(String(raw));
    if (Array.isArray(arr) && arr.length === 24) return arr.map(Number);
  } catch {
    /* fall through */
  }
  return new Array(24).fill(0);
}

// Load the small per-station Parquet and return ordered station rows.
// idx is a 0-based dense index used everywhere downstream (matrix rows,
// solver assignments) so we never have to map station_id ↔ position again.
export async function loadStations() {
  const conn = await initDuckDB();

  const res = await fetch(PARQUET_URL);
  if (!res.ok) throw new Error(`Failed to fetch Parquet (${res.status}) from ${PARQUET_URL}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await _db.registerFileBuffer('stations_demand.parquet', buf);

  const table = await conn.query(`
    SELECT
      row_number() OVER (ORDER BY station_id) - 1 AS idx,
      station_id, name, lat, lng, capacity, demand, hourly
    FROM read_parquet('stations_demand.parquet')
    ORDER BY idx
  `);

  const stations = table.toArray().map((r) => ({
    idx: Number(r.idx),
    id: String(r.station_id),
    name: String(r.name),
    lat: Number(r.lat),
    lng: Number(r.lng),
    capacity: Number(r.capacity),
    demand: Number(r.demand),
    // Signed net flow per hour (0–23), averaged over the month's weekdays. Stored
    // as a JSON string (binding-agnostic) — parse once here for the charts.
    hourly: parseHourly(r.hourly),
  }));

  return stations;
}

// Pairwise great-circle (haversine) distance matrix via a DuckDB CROSS JOIN.
//
// We compute haversine inline in SQL rather than loading the spatial extension
// over the network (ST_Distance_Sphere) — same math, no runtime extension
// fetch, fully reproducible. Returns a flat Float64Array; dist[i*n + j] metres.
export async function computeDistanceMatrix(stations) {
  const conn = await initDuckDB();
  const n = stations.length;

  const table = await conn.query(`
    WITH s AS (
      SELECT row_number() OVER (ORDER BY station_id) - 1 AS idx, lat, lng
      FROM read_parquet('stations_demand.parquet')
    )
    SELECT
      a.idx AS i,
      b.idx AS j,
      6371000.0 * 2 * asin(sqrt(
        pow(sin(radians(b.lat - a.lat) / 2), 2) +
        cos(radians(a.lat)) * cos(radians(b.lat)) *
        pow(sin(radians(b.lng - a.lng) / 2), 2)
      )) AS dist_m
    FROM s a CROSS JOIN s b
  `);

  const dist = new Float64Array(n * n);
  for (const row of table.toArray()) {
    const i = Number(row.i);
    const j = Number(row.j);
    dist[i * n + j] = Number(row.dist_m);
  }
  return dist;
}
