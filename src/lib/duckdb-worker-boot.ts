// Boot the DuckDB shell worker. Called from initShell() when the user first
// opens the SQL Shell pane — not at page load, to avoid fetching the large
// WASM binary in browsers that never use the shell (and to avoid Safari
// issues with eager WASM loading).
//
// DuckDBShell still owns the full ready-time flow (restore snapshot, ATTACH,
// timezone query, terminal output) because that depends on its config + UI
// state. This module's only job is:
//   1. Create the worker and wire SABs.
//   2. Deliver the prefetched duckdb-coi.wasm bytes via transfer.
//   3. Stash the 'ready' payload on the bridge so DuckDBShell can invoke its
//      post-ready flow immediately if init completed before mount.

import { bridge } from "./shell-bridge";
import { consumeDuckDBWasmBytes } from "./prefetch-duckdb";

let booted = false;

export function ensureDuckDBWorker(baseUrl: string): void {
  if (booted || bridge.worker) return;
  booted = true;

  const workerCreateStart = performance.now();
  bridge.workerCreateStart = workerCreateStart;
  const worker = new Worker(`${baseUrl}shell/worker.js`);
  bridge.worker = worker;

  // SharedArrayBuffer setup — same shape as the previous inline block in
  // DuckDBShell.initShell. The worker's onmessage checks for these message
  // types before init() runs, so it's safe to send them at any time.
  const oauthSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(8192) : null;
  if (oauthSAB) {
    (bridge as any)._oauthSAB = oauthSAB;
    worker.postMessage({ type: "init-oauth-sab", sab: oauthSAB });
  }

  const cancelSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : null;
  if (cancelSAB) worker.postMessage({ type: "init-cancel-sab", sab: cancelSAB });
  bridge.cancelInt32 = cancelSAB ? new Int32Array(cancelSAB) : null;
  bridge.cancelQuery = () => {
    if (bridge.cancelInt32) Atomics.store(bridge.cancelInt32, 0, 1);
  };

  // Deliver duckdb-coi.wasm bytes via transfer (or null to let the worker
  // fetch it directly as a fallback).
  void consumeDuckDBWasmBytes(baseUrl).then((bytes) => {
    if (bytes) {
      worker.postMessage({ type: "wasm-bytes", bytes }, [bytes]);
    } else {
      worker.postMessage({ type: "wasm-bytes", bytes: null });
    }
  });

  // Listen for 'ready' so DuckDBShell can find out the worker finished init
  // even if that happened before it mounted. This listener is intentionally
  // passive — it only captures state. DuckDBShell attaches its own listener
  // when it mounts, and the two coexist via addEventListener.
  const readyListener = (e: MessageEvent) => {
    const d = e.data;
    if (d?.type !== "ready") return;
    const mainThreadMs = Math.round(performance.now() - workerCreateStart);
    console.log(`[shell] Worker ready in ${mainThreadMs}ms (main-thread wall clock, worker-internal: ${d.totalMs ?? "?"}ms)`);
    if (d.timings) {
      console.log(`[shell] phase breakdown: ${JSON.stringify(d.timings)}`);
    }
    bridge.workerReadyData = {
      wasmVersion: d.wasmVersion || "",
      totalMs: d.totalMs || 0,
      timings: d.timings || [],
    };
    worker.removeEventListener("message", readyListener);
  };
  worker.addEventListener("message", readyListener);
}
