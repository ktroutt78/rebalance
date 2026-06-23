// Worker wrapper / message API. Keeps the UI thread oblivious to the worker
// protocol: init once with the station set + distance matrix, then call
// solve({depot, K, C}) which resolves with routes + metrics.

export class Solver {
  constructor() {
    // Vite resolves this to the bundled ES-module worker.
    this.worker = new Worker(new URL('./solver.worker.js', import.meta.url), {
      type: 'module',
    });
    // Tag every request so each promise resolves with ITS OWN response — never a
    // stale one from a superseded solve (the off-by-one a single slot allowed).
    this._seq = 0;
    this._pending = new Map();
    this.worker.onmessage = (e) => {
      if (e.data.type !== 'solved') return;
      const resolve = this._pending.get(e.data.id);
      if (resolve) {
        this._pending.delete(e.data.id);
        resolve(e.data.payload);
      }
    };
  }

  // Send the heavy, static data once. matrix is a Float64Array (station-station).
  init(stations, matrix) {
    // Pass only what the optimizer needs (idx/lat/lng/demand) to keep messages lean.
    const lite = stations.map((s) => ({
      idx: s.idx,
      lat: s.lat,
      lng: s.lng,
      demand: s.demand,
    }));
    this.worker.postMessage({ type: 'init', payload: { stations: lite, matrix } });
  }

  // Resolve a single solve. Each call carries a unique id so its promise is
  // matched to the matching response.
  solve({ depot, K, C }) {
    const id = ++this._seq;
    return new Promise((resolve) => {
      this._pending.set(id, resolve);
      this.worker.postMessage({ type: 'solve', payload: { depot, K, C }, id });
    });
  }
}
