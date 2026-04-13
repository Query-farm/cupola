// Prefetch duckdb-coi.wasm on the main thread and hand the bytes to the
// shell worker via postMessage. This runs in parallel with catalog load +
// React hydration, so by the time the worker is ready to compile the
// bytes they're already sitting on its message queue — no extra fetch.
//
// Note: we tried pre-compiling on the main thread via compileStreaming +
// WebAssembly.Module transfer (2026-04-11). It worked correctly (Module is
// structured-cloneable, Instance creation drops from ~100ms to ~50ms in
// Chrome and ~2000ms to ~170ms in WebKit) but the total `DuckDB({...})`
// time was unchanged in both browsers. Emscripten runtime init (LDSO,
// loadDylibs, pthread handshake, stdlib) dominates that phase, not the
// WASM compile. Not worth the complexity.

let bytesPromise: Promise<ArrayBuffer | null> | null = null;
let consumed = false;

export function prefetchDuckDBWasm(baseUrl: string): Promise<ArrayBuffer | null> {
  if (bytesPromise) return bytesPromise;
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = `${base}shell/wasm/duckdb-coi.wasm`;
  const t0 = performance.now();
  bytesPromise = fetch(url, { credentials: "same-origin" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      const bytes = await r.arrayBuffer();
      const ms = Math.round(performance.now() - t0);
      const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
      console.log(`[prefetch] duckdb-coi.wasm ready in ${ms}ms (${mb} MB)`);
      return bytes;
    })
    .catch((err) => {
      console.warn("[prefetch] duckdb-coi.wasm failed, worker will fetch directly:", err);
      bytesPromise = null;
      return null;
    });
  return bytesPromise;
}

/** Await the prefetched bytes. Marks them as consumed so callers know the
 *  ArrayBuffer is about to be transferred (and thus detached). */
export async function consumeDuckDBWasmBytes(baseUrl: string): Promise<ArrayBuffer | null> {
  if (consumed) return null;
  const bytes = await prefetchDuckDBWasm(baseUrl);
  consumed = true;
  return bytes;
}
