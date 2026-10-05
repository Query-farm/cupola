import { observeCatalogQuery } from './catalog-store';
import { decodeArrowBuffer } from './duckdb-query';
import { pendingQuery, parameterVariableSql } from './pending-query';
import { createQueryExecutor, type QueryExecutionOptions } from './query-execution';
// Boot DuckDB on the main thread via @haybarn/haybarn-wasm's AsyncDuckDB.
//
// AsyncDuckDB runs its own sub-worker (COI/EH/MVP variant selected by
// selectBundle). This module owns the lifecycle of that sub-worker and adapts
// it to the project's existing `engine.query` contract
// — no second worker layer, no custom wire protocol. The dependency surface
// for the rest of the app is unchanged: consumers keep calling
// `engine.query(sql)` and get back `{ ok, arrowBuffers, error }`.
//
// Boot is invoked from CatalogApp at mount (eager) so the wasm download
// overlaps with catalog fetch + React hydration; the shell can run as soon
// as the user opens it.

import * as duckdb from "@haybarn/haybarn-wasm";

import { engine, notifyQueryChange, setBootPhase, setEngineLifecycleError, type QueryResult } from "./shell-bridge";
import { recordDuckDBVersion } from "./duckdb-engine";
import { startIrohAdapter } from "./iroh";

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
 *  is open, the cancel SAB is registered, and `engine.query` is live. */
export function ensureDuckDB(opts: DuckDBBootOptions): Promise<void> {
  if (bootPromise) return bootPromise;
  // Seed a phase synchronously so the overlay has copy from the first frame
  // — before any awaits land. The microtask before doBoot runs is enough of
  // a gap on Safari to flicker the fallback otherwise.
  setBootPhase("Starting");
  engine.workerCreateStart = performance.now();
  bootPromise = doBoot(opts).catch((e) => {
    bootPromise = null; // allow retry
    setEngineLifecycleError(e);
    throw e;
  });
  return bootPromise;
}

async function doBoot(opts: DuckDBBootOptions): Promise<void> {
  setBootPhase("Starting");
  const { baseUrl, onAuthUrl } = opts;
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  // The pthread worker URL is passed into the COI sub-worker, which then
  // constructs `new Worker(pthreadUrl)` from its own context. Emscripten's
  // worker spawner requires an absolute URL there — a relative path like
  // `/v0.4.1/haybarn/...` fails with "is not a valid URL". Build absolute
  // URLs for everything so the sub-worker's resolution is unambiguous.
  const absBase = typeof window !== "undefined" ? `${window.location.origin}${base}` : base;
  const t0 = performance.now();
  engine.workerCreateStart = t0;
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

  setBootPhase("Checking browser support");
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
  engine.worker = subWorker;

  // Bridge a page-owned Iroh node to the worker before AsyncDuckDB starts, so
  // extensions can dial iroh:// endpoints (grainlift+iroh://). COI only; any
  // failure just disables iroh:// (see ./iroh).
  startIrohAdapter(subWorker);

  // SABs go directly to the sub-worker pre-instantiate. Haybarn's
  // handlePreInitMessage consumes both 'init-oauth-sab' and 'init-cancel-sab'
  // before the AsyncDuckDB dispatcher sees them.
  const oauthSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(8192) : null;
  if (oauthSAB) {
    (engine as unknown as { _oauthSAB: SharedArrayBuffer })._oauthSAB = oauthSAB;
    subWorker.postMessage({ type: "init-oauth-sab", sab: oauthSAB });
  }

  const cancelSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : null;
  const cancelInt32 = cancelSAB ? new Int32Array(cancelSAB) : null;
  // Asks haybarn's worker to cancel the pending query between polls. The only
  // way to cancel on builds without the interrupt flag; only the executor calls it.
  let cancelPending = () => {
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

  setBootPhase("Downloading", 0);
  // db.instantiate covers download + WASM compile + pthread spin-up, but the
  // progress callback only fires during the download. Once we see 100% we
  // flip the label to "Compiling" — on Safari the compile and
  // pthread phase can easily dwarf the download itself, and leaving the
  // label on "Downloading" makes users think the network is stuck.
  let warmingUp = false;
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (p) => {
    // InstantiationProgress reports {bytesLoaded, bytesTotal} — there is no
    // `percentage` field. Reading one yielded NaN on every tick, which the
    // guard below then discarded, so the download bar sat frozen at 0% for
    // the whole (multi-megabyte) WASM fetch.
    const pct = p.bytesTotal > 0 ? (p.bytesLoaded / p.bytesTotal) * 100 : NaN;
    if (!Number.isFinite(pct)) return;
    engine.progress?.(pct);
    if (pct >= 100) {
      if (!warmingUp) {
        warmingUp = true;
        // null progress → indeterminate sweep, since compile + pthread
        // spin-up don't emit progress events.
        setBootPhase("Compiling", null);
      }
    } else {
      setBootPhase("Downloading", Math.round(pct));
    }
  });
  if (!warmingUp) setBootPhase("Compiling", null);
  mark("instantiate");

  // Ask the Arrow exporter to preserve HUGEINT/UHUGEINT/TIME_TZ/BIT/UUID as
  // tagged extension types instead of collapsing them to lossy primitives —
  // UHUGEINT arriving as a *signed* DECIMAL(38,0) (so 2^128-1 reads as -1), BIT
  // as an untagged BLOB, and TIME_TZ as a plain TIME with its offset discarded.
  //
  // This MUST be a config key here, not `SET arrow_lossless_conversion = true`.
  // haybarn's exporter reads `webdb_.config_->arrow_lossless_conversion` (a C++
  // field fixed at instantiation) — see lib/src/webdb.cc, whose comment states
  // the flag is "pinned by the wasm packaging layer ... rather than driven from
  // session settings". `WebDB::Open` pushes that field into DuckDB's setting
  // one-way at startup, so a later SET updates the *setting* the exporter never
  // reads: `current_setting()` reports true while the output stays lossy.
  //
  // `src/lib/format.ts` keys its hugeint/timetz/bit/uuid handlers off the
  // `ARROW:extension:metadata` this produces; without it they silently never
  // fire. `.test_formats` is the guard.
  await db.open({ arrowLosslessConversion: true });

  setBootPhase("Opening the database");
  const conn = await db.connect();
  const connId = conn.useUnsafe((_db, id) => id);
  mark("connect");
  setBootPhase("Ready", 100);

  // SAB cancel — must be after instantiate. Null-checked because Safari w/o
  // crossOriginIsolated has no SharedArrayBuffer at all; non-SAB contexts can
  // still cancel via the message-based connection.cancelSent() path.
  if (cancelSAB) db.registerCancelSAB(cancelSAB);
  else cancelPending = () => { void conn.cancelSent().catch(error => console.warn('Query cancellation failed', error)); };

  // Preserve the existing { ok, arrowBuffers, error } contract. AsyncDuckDB's
  // runQuery returns a single Uint8Array of File-format Arrow IPC bytes —
  // exactly what every consumer's tableFromIPC() call expects.
  const runQueryWrapped = async (sql: string, signal?: AbortSignal): Promise<QueryResult> => {
    // Clear any stale cancel flag from a prior query that was cancelled
    // cross-surface (e.g. AskAIChat cancel hit before the shell readLoop's
    // post-query reset ran). Without this, a fresh query would be cancelled
    // immediately by the wasm-side poll. Belt-and-suspenders with the shell's
    // own post-query reset in DuckDBShell.tsx.
    if (cancelInt32) Atomics.store(cancelInt32, 0, 0);
    try {
      const bytes = signal ? await pendingQuery(db, connId, sql, signal) : await db.runQuery(connId, sql);
      // Copy out of wasm memory so tableFromIPC's view is safe even if
      // runQuery returned a subarray of a larger arena.
      //
      // Copy via a fresh Uint8Array rather than `bytes.buffer.slice(...)`:
      // with the threads build, wasm memory is backed by a SharedArrayBuffer,
      // and slicing one yields another SharedArrayBuffer. That made the real
      // type `ArrayBuffer | SharedArrayBuffer` while QueryResult promised
      // `ArrayBuffer[]`, which is the discrepancy that rippled out into every
      // consumer's buffer handling. Allocating a plain Uint8Array guarantees a
      // non-shared ArrayBuffer, so the declared type is now the true one.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return { ok: true, arrowBuffers: [copy.buffer] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };
  // The connection's own interrupt flag, in wasm memory (haybarn-wasm with
  // `getInterruptHandle`, threads builds only). A query runs synchronously in the
  // worker and one poll can process dozens of chunks, so a cancel sent as a
  // message is read only after the poll, by which point a slow remote scan has
  // often finished: a 20-chunk `slow_rows` scan stopped after one chunk ran all
  // 38s inside a single poll. Setting the flag in place reaches the query
  // mid-poll, on every engine thread, and it then fails with an interrupt error.
  //
  // Only the executor sets it, and only while its own query holds the
  // connection: the flag interrupts whatever runs on the connection. Every
  // surface cancels by aborting the signal it passed to engine.query.
  const handleSource = db as unknown as { getInterruptHandle?: (conn: number) => Promise<{ memory: SharedArrayBuffer; offset: number } | null> };
  const interruptHandle = handleSource.getInterruptHandle ? await handleSource.getInterruptHandle(connId) : null;
  const interruptFlag = interruptHandle ? new Uint8Array(interruptHandle.memory, interruptHandle.offset, 1) : null;
  engine.interruptsRunningQueries = interruptFlag !== null;
  const execute = createQueryExecutor(() => {
    if (interruptFlag) Atomics.store(interruptFlag, 0, 1);
    cancelPending();
  });
  // With the flag, interruptible work runs on every engine thread. The flag
  // arrived in haybarn-wasm 1.5.5-rc7 together with the engine fix that made
  // that safe: interrupting a remote VGI scan on engine threads used to
  // deadlock the engine (6 of 10 fresh page loads), because the scan's teardown
  // on a pthread waited on the main thread while it spun in CancelTasks.
  //
  // Without the flag (older builds), a cancelled pending query is only
  // released and its tasks on other threads keep running, so interruptible
  // work runs on the polling thread alone (`threads = 1`), with the shared
  // setting restored before releasing connection ownership.
  //
  // `threads` is a global setting, so it is read and set on a connection of its
  // own. On the shared one, a user's `BEGIN` followed by a cancelled or failed
  // statement leaves an aborted transaction, where even SET is refused ("Current
  // transaction is aborted"): the restore in `finally` threw, replaced the
  // query's own error, and left the engine at one thread for the session.
  const settingsConn = await db.connect();
  const settingsConnId = settingsConn.useUnsafe((_db, id) => id);
  const interruptible = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (interruptFlag) return work();
    const setting = await db.runQuery(settingsConnId, "SELECT current_setting('threads')");
    const threads = Number(decodeArrowBuffer(new Uint8Array(setting).buffer).getChildAt(0)?.get(0));
    if (!Number.isSafeInteger(threads) || threads < 1) throw new Error('Could not read the engine thread setting.');
    signal.throwIfAborted();
    await db.runQuery(settingsConnId, 'SET threads = 1');
    try { signal.throwIfAborted(); return await work(); }
    finally { await db.runQuery(settingsConnId, `SET threads = ${threads}`); }
  };
  engine.query = (sql, options) => observeCatalogQuery(sql, () => execute(signal => options
    ? interruptible(signal, () => runQueryWrapped(sql, signal))
    : runQueryWrapped(sql), options));
  const runPrepared = async (sql: string, params: unknown[], options?: QueryExecutionOptions): Promise<QueryResult> => {
    if (cancelInt32) Atomics.store(cancelInt32, 0, 0);
    let statementId: number | null = null;
    try {
      statementId = await db.createPrepared(connId, sql);
      options?.signal?.throwIfAborted();
      const bytes = await db.runPrepared(connId, statementId, params);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return { ok: true, arrowBuffers: [copy.buffer] };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (statementId !== null) {
        try { await db.closePrepared(connId, statementId); } catch {}
      }
    }
  };
  const parameterPrefix = `__cupola_params_${crypto.randomUUID().replaceAll('-', '')}_`;
  let parameterRun = 0;
  // WASM has no pending prepared-statement API. Bind values through its
  // prepared API into private variables, then execute foldable references
  // using the pending API. Never interpolate parameter values into SQL.
  // The variables it set are added to `bound`; the caller resets them.
  const runBound = async (sql: string, params: unknown[], signal: AbortSignal, bound: string[]): Promise<QueryResult> => {
    if (!params.length) return runQueryWrapped(sql, signal);
    const prefix = `${parameterPrefix}${++parameterRun}_`;
    const names = params.map((_, index) => `${prefix}${index}`);
    const query = parameterVariableSql(sql, await db.tokenize(sql), names);
    for (let index = 0; index < params.length; index++) {
      signal.throwIfAborted();
      const integer = typeof params[index] === 'number' && Number.isSafeInteger(params[index]);
      const set = await runPrepared(`SET VARIABLE "${names[index]}" = ?${integer ? '::BIGINT' : ''}`, [params[index]], { signal });
      if (!set.ok) return set;
      bound.push(names[index]);
    }
    signal.throwIfAborted();
    return runQueryWrapped(query, signal);
  };
  const resetVariables = async (names: string[]) => {
    for (const name of names) { try { await db.runQuery(connId, `RESET VARIABLE "${name}"`); } catch { /* already gone */ } }
  };
  engine.queryPrepared = (sql, params, options) => observeCatalogQuery(sql, () => execute(async signal => {
    if (!options) return runPrepared(sql, params);
    return interruptible(signal, async () => {
      const bound: string[] = [];
      try { return await runBound(sql, params, signal, bound); }
      finally { await resetVariables(bound); }
    });
  }, options));
  // Run several statements as one exclusive, rolled-back unit: nothing else on
  // the shared connection runs between BEGIN and ROLLBACK (the executor holds it),
  // and the ROLLBACK runs whatever happens, so a failing statement can never leave
  // the session inside an aborted transaction. SET, PRAGMA, INSTALL and the like
  // are not transactional in DuckDB; callers must keep them out.
  engine.rolledBack = <T,>(work: (run: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>, options?: QueryExecutionOptions) => execute(signal => interruptible(signal, async () => {
    const bound: string[] = [];
    const begun = await runQueryWrapped('BEGIN TRANSACTION', signal);
    if (!begun.ok) throw new Error(begun.error || 'Could not start a transaction.');
    try {
      return await work((sql, params = []) => runBound(sql, params, signal, bound));
    } finally {
      // "No transaction is active" means the work rolled back itself; that's fine.
      try { await db.runQuery(connId, 'ROLLBACK'); } catch { /* not in a transaction */ }
      // Variables are session state, not transactional: clear them after the rollback.
      await resetVariables(bound);
    }
  }), options ?? {});
  engine.getTableNames = (sql: string) => execute(() => conn.getTableNames(sql));
  // Keep the shell alias on the same connection queue.
  engine.querySync = engine.query;
  notifyQueryChange();

  const version = await db.getVersion();
  // The AI system prompt states the DuckDB version; record the real one rather
  // than letting the prompt keep asserting a hardcoded literal.
  recordDuckDBVersion(version);
  const totalMs = Math.round(performance.now() - t0);
  engine.workerReadyData = { wasmVersion: version, totalMs, timings };
  console.log(`[shell] worker ready in ${totalMs}ms (haybarn ${version})`);
  console.log(`[shell] phase breakdown: ${JSON.stringify(timings)}`);
}
