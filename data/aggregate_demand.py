#!/usr/bin/env python3
"""
aggregate_demand.py — REAL Citi Bike net-flow demand → stations_demand.parquet

Offline, one-time (re-runnable). The canonical data pipeline behind the app, and
itself a DuckDB showcase: pull ONE representative NYC weekday of trips from the
official Citi Bike S3, compute each station's net flow in DuckDB, and write the
exact Parquet schema the runtime already loads (see src/duckdb.js):

    station_id VARCHAR, name VARCHAR, lat DOUBLE, lng DOUBLE, capacity INTEGER, demand INTEGER

demand = (rides ENDING at a station) − (rides STARTING there) over the day.
Positive = bikes accumulate = surplus (truck picks up); negative = deficit (drops off).
This is the headline: real operational imbalance from real rides, not invented.

Run (uv supplies duckdb on a supported Python; system Python 3.14 has no wheels yet):

    uv run --with duckdb --python 3.12 data/aggregate_demand.py
    # options: --month 202503 --date 2025-03-19 --top 250

The raw monthly file is ~600 MB zipped / several GB unzipped. It is cached under
data/.cache/ (gitignored), NEVER committed, and NEVER loaded in the browser.
"""

import argparse
import json
import os
import sys
import glob
import zipfile
import random
import urllib.request
from datetime import date
from pathlib import Path

import duckdb

BUCKET = "https://s3.amazonaws.com/tripdata"
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / ".cache"
OUT = ROOT / "public" / "stations_demand.parquet"

# View box — mirrors src/config.js MANHATTAN_BBOX so stations land where the map
# opens, and any stray Jersey-side coordinates are dropped. (The NYC trip file
# already excludes the JC-prefixed Jersey City system entirely.)
BBOX = dict(min_lng=-74.02, min_lat=40.695, max_lng=-73.91, max_lat=40.82)

# Modern post-2020 schema (coords embedded per trip — no separate station file).
MODERN_COLS = {
    "ride_id", "rideable_type", "started_at", "ended_at",
    "start_station_name", "start_station_id", "end_station_name", "end_station_id",
    "start_lat", "start_lng", "end_lat", "end_lng", "member_casual",
}

PLACEHOLDER_CAPACITY = 50   # dock capacity isn't in the trip feed; the solver ignores this column
# Keep peak demand comfortably under the app's default C (30) so the map opens
# fully served, while leaving slider range below it (tightening C strands the
# busiest hubs). These are scaling choices on real net flow, not the data itself.
DEMAND_CLIP = 24            # clip scaled demand into a C-slider-friendly range
SCALE_TARGET = 18           # map ~95th-pct |net flow| to this many bikes
SEED = 20250319


def log(msg):
    print(msg, flush=True)


def resolve_file(month: str) -> str:
    """Confirm the exact NYC filename exists in the bucket before downloading.

    Naming/extension is inconsistent across eras, so we verify against the live
    listing + a HEAD rather than trusting a hard-coded name. Reject JC files.
    """
    if month.upper().startswith("JC"):
        sys.exit(f"Refusing JC (Jersey City) file '{month}'. Use NYC files only.")
    fname = f"{month}-citibike-tripdata.zip"
    url = f"{BUCKET}/{fname}"

    # Membership in the bucket index (authoritative for naming).
    try:
        with urllib.request.urlopen(BUCKET + "/", timeout=60) as r:
            listing = r.read().decode("utf-8", "replace")
    except Exception as e:
        sys.exit(f"Could not fetch bucket listing: {e}")
    if f"<Key>{fname}</Key>" not in listing:
        # surface nearby NYC keys to help pick a valid one
        import re
        keys = [k for k in re.findall(r"<Key>([^<]+)</Key>", listing)
                if not k.upper().startswith("JC") and "citibike" in k.lower()]
        sys.exit(f"'{fname}' not in bucket. Recent NYC keys:\n  " + "\n  ".join(keys[-12:]))

    # HEAD to confirm reachable.
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            size = int(r.headers.get("Content-Length", 0))
    except Exception as e:
        sys.exit(f"HEAD {url} failed: {e}")
    log(f"  source: {url}  (~{size / 1e6:.0f} MB)")
    return url, fname


def download(url: str, fname: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / fname
    if dest.exists() and dest.stat().st_size > 1_000_000:
        log(f"  cached zip: {dest} ({dest.stat().st_size / 1e6:.0f} MB) — skipping download")
        return dest
    log(f"  downloading → {dest} …")

    def hook(block, bs, total):
        if total > 0 and block % 256 == 0:
            pct = min(100, block * bs * 100 // total)
            print(f"\r    {pct:3d}%", end="", flush=True)

    urllib.request.urlretrieve(url, dest, reporthook=hook)
    print()
    return dest


def extract(zip_path: Path, month: str) -> list[str]:
    outdir = CACHE / month
    if outdir.exists():
        csvs = _find_csvs(outdir)
        if csvs:
            log(f"  extracted CSVs present in {outdir} ({len(csvs)} part(s)) — skipping unzip")
            return csvs
    log(f"  unzipping → {outdir} …")
    outdir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(outdir)
    csvs = _find_csvs(outdir)
    if not csvs:
        sys.exit(f"No CSV parts found under {outdir} after unzip.")
    log(f"  found {len(csvs)} CSV part(s)")
    return csvs


def _find_csvs(root: Path) -> list[str]:
    return [
        p for p in glob.glob(str(root / "**" / "*.csv"), recursive=True)
        if "__MACOSX" not in p and not os.path.basename(p).startswith("._")
    ]


def verify_header(csv_path: str):
    """Fail loudly if the file isn't the modern schema we coded against."""
    with open(csv_path, "r", encoding="utf-8", errors="replace") as f:
        header = f.readline().strip().lstrip("﻿")
    cols = {c.strip().strip('"').lower() for c in header.split(",")}
    missing = MODERN_COLS - cols
    if missing:
        sys.exit(
            "Unexpected CSV schema — this script targets the post-2020 modern format.\n"
            f"  file:    {csv_path}\n  header:  {sorted(cols)}\n  missing: {sorted(missing)}"
        )
    log(f"  schema OK ({len(cols)} columns, modern format)")


def file_list_sql(csvs: list[str]) -> str:
    return "[" + ",".join("'" + p.replace("'", "''") + "'" for p in csvs) + "]"


def aggregate(con, csvs: list[str], day: str, top: int):
    files = file_list_sql(csvs)
    # Read every column as VARCHAR so station_id strings (e.g. '6432.10') keep
    # their exact form; cast numerics explicitly. Filter to the target day.
    con.execute(f"""
        CREATE OR REPLACE TABLE day AS
        SELECT
            start_station_id  AS ssid, end_station_id   AS esid,
            start_station_name AS ssn, end_station_name  AS esn,
            TRY_CAST(start_lat AS DOUBLE) AS slat, TRY_CAST(start_lng AS DOUBLE) AS slng,
            TRY_CAST(end_lat   AS DOUBLE) AS elat, TRY_CAST(end_lng   AS DOUBLE) AS elng
        FROM read_csv_auto({files}, header=true, all_varchar=true, union_by_name=true)
        WHERE TRY_CAST(started_at AS DATE) = DATE '{day}';
    """)
    n_trips = con.execute("SELECT count(*) FROM day").fetchone()[0]
    if n_trips == 0:
        sys.exit(f"No trips found for {day}. Is the date inside the chosen month?")
    log(f"  trips on {day}: {n_trips:,}")

    # Role-agnostic per-station coords/name/activity (median coords = GPS-robust).
    con.execute("""
        CREATE OR REPLACE TABLE coords AS
            SELECT ssid AS sid, ssn AS nm, slat AS lat, slng AS lng FROM day WHERE ssid IS NOT NULL AND ssid <> ''
            UNION ALL
            SELECT esid,        esn,       elat,       elng       FROM day WHERE esid IS NOT NULL AND esid <> '';

        CREATE OR REPLACE TABLE meta AS
            SELECT sid, any_value(nm) AS name, median(lat) AS lat, median(lng) AS lng, count(*) AS activity
            FROM coords WHERE lat IS NOT NULL AND lng IS NOT NULL
            GROUP BY sid;

        CREATE OR REPLACE TABLE flows AS
            SELECT m.sid, m.name, m.lat, m.lng, m.activity,
                   COALESCE(e.n, 0) - COALESCE(s.n, 0) AS net_raw   -- ends − starts
            FROM meta m
            LEFT JOIN (SELECT ssid AS sid, count(*) n FROM day GROUP BY ssid) s ON s.sid = m.sid
            LEFT JOIN (SELECT esid AS sid, count(*) n FROM day GROUP BY esid) e ON e.sid = m.sid;
    """)

    # Keep valid, non-test stations inside the Manhattan view box; take the
    # busiest `top` so the parquet stays a few hundred rows (SPEC §3) and the
    # map stays legible + the solver fast.
    rows = con.execute(f"""
        SELECT sid, name, lat, lng, activity, net_raw
        FROM flows
        WHERE lat BETWEEN {BBOX['min_lat']} AND {BBOX['max_lat']}
          AND lng BETWEEN {BBOX['min_lng']} AND {BBOX['max_lng']}
          AND sid IS NOT NULL AND sid <> ''
          AND name IS NOT NULL AND lower(name) NOT LIKE '%test%'
        ORDER BY activity DESC, sid        -- sid tiebreak ⇒ deterministic across runs/threads
        LIMIT {top};
    """).fetchall()
    if not rows:
        sys.exit("No stations survived filtering — check bbox/date.")

    p95 = con.execute("""
        SELECT quantile_cont(abs(net_raw), 0.95)
        FROM (SELECT net_raw FROM flows
              WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?)
    """, [BBOX['min_lat'], BBOX['max_lat'], BBOX['min_lng'], BBOX['max_lng']]).fetchone()[0]
    return rows, (p95 or 1.0)


def compute_hourly(con, csvs):
    """Per-station net flow by hour of day (0–23), AVERAGED across every weekday
    in the chosen month (Mon–Fri). Averaging across days reads cleaner than one
    noisy day. Uses ended_at for arrivals and started_at for departures so each
    bike movement lands in the hour it actually happened. Independent of the
    solver's single-day `demand` (which is left untouched)."""
    files = file_list_sql(csvs)
    con.execute(f"""
        CREATE OR REPLACE TABLE month_wk AS
        SELECT start_station_id AS ssid, end_station_id AS esid,
               TRY_CAST(started_at AS TIMESTAMP) AS st,
               TRY_CAST(ended_at   AS TIMESTAMP) AS et
        FROM read_csv_auto({files}, header=true, all_varchar=true, union_by_name=true)
        WHERE isodow(TRY_CAST(started_at AS DATE)) BETWEEN 1 AND 5;   -- weekdays only
    """)
    ndays = con.execute("SELECT count(DISTINCT CAST(st AS DATE)) FROM month_wk WHERE st IS NOT NULL").fetchone()[0]
    ndays = max(1, ndays)
    log(f"  hourly profile: averaging over {ndays} weekday(s) in the month")

    rows = con.execute("""
        WITH starts AS (
            SELECT ssid AS sid, hour(st) AS hr, count(*) AS n
            FROM month_wk WHERE ssid IS NOT NULL AND ssid <> '' AND st IS NOT NULL GROUP BY 1, 2
        ), ends AS (
            SELECT esid AS sid, hour(et) AS hr, count(*) AS n
            FROM month_wk WHERE esid IS NOT NULL AND esid <> '' AND et IS NOT NULL GROUP BY 1, 2
        )
        SELECT sid, hr, COALESCE(e.n, 0) - COALESCE(s.n, 0) AS net   -- arrivals − departures
        FROM starts s FULL OUTER JOIN ends e USING (sid, hr)
        WHERE sid IS NOT NULL AND hr IS NOT NULL
    """).fetchall()

    hourly = {}
    for sid, hr, net in rows:
        arr = hourly.setdefault(str(sid), [0.0] * 24)
        arr[int(hr)] = round(net / ndays, 2)
    return hourly, ndays


def scale_and_balance(rows, p95):
    """Scale raw net flow to slider-friendly magnitudes, clip, then nudge the
    set to net exactly zero so the VRP is solvable (SPEC §3 step 4)."""
    scale = SCALE_TARGET / max(1.0, p95)
    log(f"  scale factor: {scale:.3f}  (95th-pct |net_raw| ≈ {p95:.0f} → ~{SCALE_TARGET})")

    stations = []
    for sid, name, lat, lng, activity, net_raw in rows:
        d = round(net_raw * scale)
        d = max(-DEMAND_CLIP, min(DEMAND_CLIP, d))
        stations.append([str(sid), str(name), float(lat), float(lng), PLACEHOLDER_CAPACITY, int(d)])

    rng = random.Random(SEED)
    net = sum(s[5] for s in stations)
    residual_before = net
    guard = 0
    while net != 0 and guard < 1_000_000:
        guard += 1
        s = stations[rng.randrange(len(stations))]
        step = -1 if net > 0 else 1
        if abs(s[5] + step) <= DEMAND_CLIP:
            s[5] += step
            net += step
    return stations, scale, residual_before


def main():
    ap = argparse.ArgumentParser(description="Citi Bike net-flow demand → stations_demand.parquet")
    ap.add_argument("--month", default="202503", help="YYYYMM of NYC monthly file (default 202503)")
    ap.add_argument("--date", default="2025-03-19", help="representative weekday YYYY-MM-DD (default 2025-03-19, a Wed)")
    ap.add_argument("--top", type=int, default=250, help="keep N busiest in-bbox stations (default 250)")
    args = ap.parse_args()

    d = date.fromisoformat(args.date)
    log(f"Citi Bike net-flow aggregation")
    log(f"  weekday: {args.date} ({d.strftime('%A')})")
    if d.weekday() >= 5:
        log("  ⚠ that date is a weekend — SPEC asks for a representative weekday.")

    url, fname = resolve_file(args.month)
    zip_path = download(url, fname)
    csvs = extract(zip_path, args.month)
    verify_header(sorted(csvs)[0])

    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    rows, p95 = aggregate(con, csvs, args.date, args.top)
    stations, scale, residual_before = scale_and_balance(rows, p95)
    hourly, ndays = compute_hourly(con, csvs)

    # `hourly` ships as a JSON-encoded 24-array (VARCHAR) — robust across any
    # Arrow/DuckDB-Wasm binding, parsed once in src/duckdb.js. Keeps one file.
    insert_rows = []
    for sid, name, lat, lng, cap, dem in stations:
        prof = hourly.get(sid, [0.0] * 24)
        insert_rows.append([sid, name, lat, lng, cap, dem, json.dumps(prof)])

    con.execute("""
        CREATE OR REPLACE TABLE final
        (station_id VARCHAR, name VARCHAR, lat DOUBLE, lng DOUBLE,
         capacity INTEGER, demand INTEGER, hourly VARCHAR);
    """)
    con.executemany("INSERT INTO final VALUES (?,?,?,?,?,?,?)", insert_rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY (SELECT * FROM final ORDER BY station_id) TO '{OUT}' (FORMAT PARQUET, COMPRESSION ZSTD);")

    surplus = [s for s in stations if s[5] > 0]
    deficit = [s for s in stations if s[5] < 0]
    log("")
    log(f"✓ Wrote {OUT}")
    log(f"  stations:                 {len(stations)}")
    log(f"  surplus / deficit / zero: {len(surplus)} / {len(deficit)} / {len(stations)-len(surplus)-len(deficit)}")
    log(f"  bikes to move (Σ surplus):{sum(s[5] for s in surplus)}")
    log(f"  residual before balance:  {residual_before}  → after: {sum(s[5] for s in stations)}")


if __name__ == "__main__":
    main()
