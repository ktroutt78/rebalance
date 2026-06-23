import { defineConfig } from 'vite';

// DuckDB-Wasm ships large .wasm + worker assets and uses top-level await.
// exclude it from dep pre-bundling so Vite serves the real worker entrypoints.
export default defineConfig({
  base: './',
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  build: {
    target: 'esnext', // top-level await in DuckDB-Wasm
  },
  worker: {
    format: 'es',
  },
});
