// Coverage check: load the live public/stations_demand.parquet, build the
// haversine matrix, and run the solver across K=1..8 at a range of C. Reports
// stations served vs demanding — the proof that the data is solvable by the
// existing solver. Works on synthetic OR real data (data-only swap).
//
// Run:  node test/coverage.mjs   (needs @duckdb/node-api devDep)

import { DuckDBInstance } from '@duckdb/node-api';
import { performance } from 'node:perf_hooks';

globalThis.self = globalThis;
globalThis.performance = performance;
let captured = null;
globalThis.postMessage = (m) => (captured = m);
await import('../src/solver.worker.js');

const P = 'public/stations_demand.parquet';
const inst = await DuckDBInstance.create(':memory:');
const conn = await inst.connect();
const rows = await (
  await conn.run(
    `SELECT row_number() OVER (ORDER BY station_id)-1 idx, lat, lng, demand
     FROM read_parquet('${P}') ORDER BY idx`
  )
).getRows();
const stations = rows.map((r) => ({ idx: Number(r[0]), lat: Number(r[1]), lng: Number(r[2]), demand: Number(r[3]) }));
const N = stations.length;

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
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) matrix[i * N + j] = hav(stations[i], stations[j]);

const depot = { lng: -73.993, lat: 40.735 };
self.onmessage({ data: { type: 'init', payload: { stations, matrix } } });

const demanders = stations.filter((s) => s.demand !== 0).length;
console.log(`stations: ${N}  demanding: ${demanders}  Σ|demand|: ${stations.reduce((s, x) => s + Math.abs(x.demand), 0)}`);
console.log('coverage (served/demanding, unsatisfied, total km):');
for (const K of [1, 2, 3, 4, 6, 8]) {
  let line = `  K=${K}: `;
  for (const C of [20, 30, 40, 60]) {
    self.onmessage({ data: { type: 'solve', payload: { depot, K, C } } });
    const m = captured.payload.metrics;
    line += `C${C}:${m.satisfied}/${demanders}(u${m.unsatisfied},${(m.totalDistance / 1000).toFixed(0)}km)  `;
  }
  console.log(line);
}
