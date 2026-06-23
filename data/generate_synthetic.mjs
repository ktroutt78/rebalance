// Offline synthetic data generator — stand-in for the real S3 pipeline.
//
// Produces `stations_demand.parquet` with EXACTLY the runtime schema the real
// `aggregate_demand.py` will emit:
//
//     station_id  VARCHAR
//     name        VARCHAR
//     lat         DOUBLE
//     lng         DOUBLE
//     capacity    INTEGER   -- dock capacity
//     demand      INTEGER   -- signed net flow: +surplus (pick up), -deficit (drop off)
//
// Demand is built with a downtown→uptown spatial gradient (commuters pile up
// downtown by day) plus noise, then ADJUSTED so the system nets to ~zero — the
// solvability invariant from SPEC §3. Same routine, real numbers later.
//
// Run:  npm run gen:synthetic
//
// Uses DuckDB (the project's data engine) to write the Parquet, so this file
// also demonstrates the offline DuckDB COPY ... TO ... (FORMAT PARQUET) path.

import { DuckDBInstance } from '@duckdb/node-api';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'stations_demand.parquet');

const N_STATIONS = 140;

// Inset Manhattan bbox (kept off the rivers for cleaner synthetic plotting).
const BBOX = { minLng: -74.012, minLat: 40.703, maxLng: -73.935, maxLat: 40.804 };

// Deterministic PRNG (mulberry32) so the committed Parquet is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240617);

const AVENUES = ['Hudson', 'Greenwich', 'Bowery', 'Lex', 'Park', 'Madison', 'Amsterdam', 'Columbus', 'West End', 'Pleasant'];

// Demand "poles": commute creates LOCAL surplus/deficit pairs (a transit hub
// fills while the residential blocks around it empty), interspersed across the
// city — not one monotonic downtown→uptown gradient. Interleaved signs mean any
// geographic truck cluster naturally contains both pickups and dropoffs, which
// is both more realistic than a gradient and far healthier for cluster-first
// routing. Each pole pushes nearby stations toward its sign with Gaussian falloff.
function makePoles() {
  const N_POLES = 11;
  const poles = [];
  for (let p = 0; p < N_POLES; p++) {
    poles.push({
      lat: BBOX.minLat + rand() * (BBOX.maxLat - BBOX.minLat),
      lng: BBOX.minLng + rand() * (BBOX.maxLng - BBOX.minLng),
      sign: p % 2 === 0 ? 1 : -1, // alternate so roughly half surplus, half deficit
      strength: 9 + rand() * 9, // 9..18 bikes at the core
      sigma: 0.009 + rand() * 0.01, // ~1.0–2.1 km influence radius (degrees)
    });
  }
  return poles;
}

function makeStations() {
  const poles = makePoles();
  const stations = [];
  for (let i = 0; i < N_STATIONS; i++) {
    const lng = BBOX.minLng + rand() * (BBOX.maxLng - BBOX.minLng);
    const lat = BBOX.minLat + rand() * (BBOX.maxLat - BBOX.minLat);

    // Sum Gaussian contributions from every pole (cos-corrected for longitude).
    let signal = 0;
    for (const pole of poles) {
      const dx = lat - pole.lat;
      const dy = (lng - pole.lng) * Math.cos((lat * Math.PI) / 180);
      const d2 = dx * dx + dy * dy;
      signal += pole.sign * pole.strength * Math.exp(-d2 / (2 * pole.sigma * pole.sigma));
    }
    signal += (rand() - 0.5) * 4; // jitter

    let demand = Math.round(signal);
    demand = Math.max(-18, Math.min(18, demand));
    // Stations far from any pole settle near zero → already-balanced docks.
    if (Math.abs(demand) <= 1 && rand() < 0.5) demand = 0;

    const capacity = 20 + Math.floor(rand() * 41); // 20..60 docks

    stations.push({
      station_id: `S${String(i + 1).padStart(3, '0')}`,
      name: `${AVENUES[i % AVENUES.length]} & ${1 + Math.floor(rand() * 125)} St`,
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      capacity,
      demand,
    });
  }
  return stations;
}

// Drive the system net to exactly zero by nudging random non-zero stations ±1
// against the residual sign. Preserves realism (small per-station tweaks).
function zeroBalance(stations) {
  const net = () => stations.reduce((s, st) => s + st.demand, 0);
  let guard = 0;
  while (net() !== 0 && guard++ < 100000) {
    const residual = net();
    const dir = residual > 0 ? -1 : 1; // push demand toward zero-sum
    // Prefer adjusting a station whose magnitude is already nonzero & same sign
    // as the push direction would not overshoot into a huge spike.
    const idx = Math.floor(rand() * stations.length);
    const st = stations[idx];
    const next = st.demand + dir;
    if (Math.abs(next) <= 20) st.demand = next;
  }
  return net();
}

async function main() {
  const stations = makeStations();
  const residual = zeroBalance(stations);

  const surplus = stations.filter((s) => s.demand > 0);
  const deficit = stations.filter((s) => s.demand < 0);
  const totalSurplus = surplus.reduce((s, st) => s + st.demand, 0);

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  await conn.run(`
    CREATE TABLE stations (
      station_id VARCHAR,
      name       VARCHAR,
      lat        DOUBLE,
      lng        DOUBLE,
      capacity   INTEGER,
      demand     INTEGER
    );
  `);

  // Build a single multi-row VALUES insert (N is small).
  const esc = (s) => s.replace(/'/g, "''");
  const values = stations
    .map(
      (s) =>
        `('${esc(s.station_id)}','${esc(s.name)}',${s.lat},${s.lng},${s.capacity},${s.demand})`
    )
    .join(',\n');
  await conn.run(`INSERT INTO stations VALUES\n${values};`);

  await conn.run(
    `COPY (SELECT * FROM stations ORDER BY station_id) TO '${OUT}' (FORMAT PARQUET, COMPRESSION ZSTD);`
  );

  console.log(`✓ Wrote ${OUT}`);
  console.log(`  stations:        ${stations.length}`);
  console.log(`  surplus / deficit stations: ${surplus.length} / ${deficit.length}`);
  console.log(`  total bikes to move (Σ surplus): ${totalSurplus}`);
  console.log(`  system net (should be 0):        ${residual}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
