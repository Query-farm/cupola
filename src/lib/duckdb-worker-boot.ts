// Boot DuckDB on the main thread via @haybarn/haybarn-wasm's AsyncDuckDB.
//
// AsyncDuckDB runs its own sub-worker (COI/EH/MVP variant selected by
// selectBundle). This module owns the lifecycle of that sub-worker and adapts
// it to the project's existing `bridge.query` / `bridge.cancelQuery` contract
// — no second worker layer, no custom wire protocol. The dependency surface
// for the rest of the app is unchanged: consumers keep calling
// `bridge.query(sql)` and get back `{ ok, arrowBuffers, error }`.
//
// Boot is invoked from CatalogApp at mount (eager) so the wasm download
// overlaps with catalog fetch + React hydration; the shell can run as soon
// as the user opens it.

import * as duckdb from "@haybarn/haybarn-wasm";

import { bridge, notifyQueryChange } from "./shell-bridge";

let bootPromise: Promise<void> | null = null;

/** Resolve the effective thread count from the settings value.
 *  0 = auto: 1 for Safari (struggles with pthread sub-workers), hardwareConcurrency for others. */
export function resolveThreadCount(settingValue: number): number {
  if (settingValue > 0) return settingValue;
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) return 1;
  return navigator.hardwareConcurrency || 4;
}

export interface DuckDBBootOptions {
  /** Origin + base path for haybarn artifacts. E.g. "/v0.3.48/". */
  baseUrl: string;
  /** Optional: forward VGI extension's interactive OAuth popup request. */
  onAuthUrl?: (url: string) => void;
}

/** Idempotent boot. Resolves when AsyncDuckDB is instantiated, a connection
 *  is open, the cancel SAB is registered, and `bridge.query` is live. */
export function ensureDuckDB(opts: DuckDBBootOptions): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = doBoot(opts).catch((e) => {
    bootPromise = null; // allow retry
    throw e;
  });
  return bootPromise;
}

async function doBoot(opts: DuckDBBootOptions): Promise<void> {
  const { baseUrl, onAuthUrl } = opts;
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  // The pthread worker URL is passed into the COI sub-worker, which then
  // constructs `new Worker(pthreadUrl)` from its own context. Emscripten's
  // worker spawner requires an absolute URL there — a relative path like
  // `/v0.4.1/haybarn/...` fails with "is not a valid URL". Build absolute
  // URLs for everything so the sub-worker's resolution is unambiguous.
  const absBase = typeof window !== "undefined" ? `${window.location.origin}${base}` : base;
  const t0 = performance.now();
  bridge.workerCreateStart = t0;
  const timings: { phase: string; ms: number }[] = [];
  let phaseT = t0;
  const mark = (phase: string) => {
    const now = performance.now();
    timings.push({ phase, ms: Math.round(now - phaseT) });
    phaseT = now;
  };

  const BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
      mainModule: `${absBase}haybarn/duckdb-mvp.wasm`,
      mainWorker: `${absBase}haybarn/duckdb-browser-mvp.worker.js`,
    },
    eh: {
      mainModule: `${absBase}haybarn/duckdb-eh.wasm`,
      mainWorker: `${absBase}haybarn/duckdb-browser-eh.worker.js`,
    },
    coi: {
      mainModule: `${absBase}haybarn/duckdb-coi.wasm`,
      mainWorker: `${absBase}haybarn/duckdb-browser-coi.worker.js`,
      pthreadWorker: `${absBase}haybarn/duckdb-browser-coi.pthread.worker.js`,
    },
  };

  const bundle = await duckdb.selectBundle(BUNDLES);
  mark("select-bundle");

  // Bypass haybarn's `createWorker(url)` which fetches the worker.js and
  // wraps it as a Blob URL. The Blob form has a null origin in WebKit, so
  // the worker script's `//# sourceMappingURL=duckdb-browser-coi.worker.js.map`
  // comment resolves to a `blob://null...` URL that Safari refuses with
  // "Not allowed to load local resource". Our worker is served same-origin
  // from /haybarn/ (R2 via the Cloudflare Worker), so plain `new Worker(url)`
  // works without the Blob indirection and preserves source-map URLs.
  const subWorker = new Worker(bundle.mainWorker!);
  bridge.worker = subWorker;

  // SABs go directly to the sub-worker pre-instantiate. handlePreInitMessage
  // (shipped in @haybarn/haybarn-wasm@1.5.3-rc7) consumes both 'init-oauth-sab'
  // and 'init-cancel-sab' before the AsyncDuckDB dispatcher sees them.
  const oauthSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(8192) : null;
  if (oauthSAB) {
    (bridge as unknown as { _oauthSAB: SharedArrayBuffer })._oauthSAB = oauthSAB;
    subWorker.postMessage({ type: "init-oauth-sab", sab: oauthSAB });
  }

  const cancelSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : null;
  const cancelInt32 = cancelSAB ? new Int32Array(cancelSAB) : null;
  bridge.cancelInt32 = cancelInt32;
  bridge.cancelQuery = () => {
    if (cancelInt32) Atomics.store(cancelInt32, 0, 1);
  };

  // VGI extension's interactive OAuth popup fires postMessage({type:'open-auth-url',url})
  // straight from inside the wasm via globalThis.postMessage — it bypasses
  // AsyncDuckDBDispatcher entirely. Whitelist this specific type rather than
  // blind-forwarding unknown messages (which would risk duplicating legit
  // dispatcher responses).
  if (onAuthUrl) {
    subWorker.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | undefined;
      if (d?.type === "open-auth-url" && typeof d.url === "string") {
        onAuthUrl(d.url);
      }
    });
  }

  // Map AsyncDuckDB log entries to the existing console channel. WARNING+
  // levels are surfaced; verbose levels are dropped to avoid spam.
  const logger: duckdb.Logger = {
    log(entry) {
      if (entry.level < duckdb.LogLevel.WARNING) return;
      const value = (entry as { value?: unknown }).value;
      console.warn(`[haybarn ${entry.origin}/${entry.topic}]`, value ?? "");
    },
  };

  const db = new duckdb.AsyncDuckDB(logger, subWorker);

  await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (p) => {
    // Surface init progress as percentage for UX overlays (e.g. KeplerMap).
    const pct = Number(p.percentage);
    if (Number.isFinite(pct)) bridge.progress?.(pct);
  });
  mark("instantiate");

  const conn = await db.connect();
  const connId = conn.useUnsafe((_db, id) => id);
  mark("connect");

  // SAB cancel — must be after instantiate. Null-checked because Safari w/o
  // crossOriginIsolated has no SharedArrayBuffer at all; non-SAB contexts can
  // still cancel via the message-based connection.cancelSent() path.
  if (cancelSAB) db.registerCancelSAB(cancelSAB);

  // Preserve the existing { ok, arrowBuffers, error } contract. AsyncDuckDB's
  // runQuery returns a single Uint8Array of File-format Arrow IPC bytes —
  // exactly what every consumer's tableFromIPC() call expects.
  const runQueryWrapped = async (sql: string) => {
    try {
      const bytes = await db.runQuery(connId, sql);
      // Detach the underlying buffer so tableFromIPC's Uint8Array view is
      // safe even if runQuery returns a subarray of a larger arena.
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return { ok: true, arrowBuffers: [ab] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };
  bridge.query = runQueryWrapped;
  // Pending vs non-streaming distinction (today's `query-sync`) is moot under
  // AsyncDuckDB.runQuery, which always returns a single File-format buffer.
  bridge.querySync = runQueryWrapped;
  notifyQueryChange();

  const version = await db.getVersion();
  const totalMs = Math.round(performance.now() - t0);
  bridge.workerReadyData = { wasmVersion: version, totalMs, timings };
  console.log(`[shell] worker ready in ${totalMs}ms (haybarn ${version})`);
  console.log(`[shell] phase breakdown: ${JSON.stringify(timings)}`);
}
