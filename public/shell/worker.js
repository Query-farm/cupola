// DuckDB-WASM Worker — runs DuckDB in a Web Worker where sync XHR and SAB work.

// Append the cupola release version (extracted from /vX.Y.Z/ in self.location)
// so IndexedDB snapshots from prior releases are not restored into a worker
// whose JS-side runtime state differs. The duckdb-coi.wasm bytes can be
// identical across releases, but a snapshot also captures function-table
// indices populated by Embind at startup — those depend on the worker.js
// init order, so a snapshot is only safe to restore in the same release.
var RELEASE_VERSION = self.location.pathname.match(/\/v(\d+\.\d+\.\d+)\//)?.[1] || 'unversioned';
var WASM_BUILD_VERSION = "duckdb-1.5.1-vgi-coi-20260409-r" + RELEASE_VERSION;

// Sentry — load and init before importScripts of duckdb-coi.js so WASM init
// errors get captured. Same DSN as the main thread (the DSN is public and tied
// to the project, not a secret). Release derived from the URL path so it
// matches the browser's `cupola@<version>` prefix.
try {
    importScripts('./sentry-bootstrap.js');
    if (self.SentryWorker) {
        self.SentryWorker.init({
            dsn: "https://d0991fb45d2c62f5d25db86f2985cb79@o4511299556081664.ingest.us.sentry.io/4511299558637568",
            release: "cupola@" + RELEASE_VERSION,
            environment: "production",
        });
    }
} catch (e) {
    console.error('[shell-worker] Sentry bootstrap failed:', e);
}

// OAuth SAB state — initialized from main thread
var oauthSAB = null;
var oauthInt32 = null;
var oauthBytes = null;

// Timing — captured from worker boot so init() can log a phase breakdown
var WORKER_T0 = performance.now();
var T_BEFORE_IMPORT_SCRIPTS = 0;
var T_AFTER_IMPORT_SCRIPTS = 0;

// Thread count from the main thread. null = use worker default (hardwareConcurrency).
// Main thread sends this before init() based on the user's settings and browser.
var configuredThreadCount = null;

// Bytes for duckdb-coi.wasm delivered by the main thread. The main thread
// prefetches this 31 MB blob in parallel with catalog load, then transfers
// it here before init() runs. If bytes === null, we fall back to letting
// Emscripten fetch the file itself.
var preloadedWasmBytes = null;
var resolveWasmBytes = null;
var wasmBytesPromise = new Promise(function(r) { resolveWasmBytes = r; });

// Minimal DUCKDB_RUNTIME shim — the COI Emscripten module calls through
// globalThis.DUCKDB_RUNTIME for filesystem, feature detection, and UDFs.
// We only need stubs since VGI tables use HTTP (not the DuckDB filesystem).
globalThis.DUCKDB_RUNTIME = {
    testPlatformFeature: (mod, feature) => feature === 1 ? true : false, // 1=BIGINT64ARRAY
    getDefaultDataProtocol: () => 0, // NATIVE
    openFile: () => 0,
    closeFile: () => {},
    syncFile: () => {},
    truncateFile: () => {},
    readFile: () => 0,
    writeFile: () => 0,
    getLastFileModificationTime: () => 0,
    checkDirectory: () => false,
    createDirectory: () => {},
    removeDirectory: () => {},
    listDirectoryEntries: () => false,
    glob: () => {},
    moveFile: () => {},
    checkFile: () => false,
    removeFile: () => {},
    dropFile: () => {},
    callScalarUDF: () => {},
};

T_BEFORE_IMPORT_SCRIPTS = performance.now();
importScripts('./wasm/duckdb-coi.js');
T_AFTER_IMPORT_SCRIPTS = performance.now();

// Cancel signal via SharedArrayBuffer — main thread sets [0]=1 to request cancel
var cancelFlag = null;

function callSRet(mod, funcName, argTypes, args) {
    const sp = mod.stackSave();
    const response = mod.stackAlloc(3 * 8);
    argTypes.unshift('number');
    args.unshift(response);
    mod.ccall(funcName, null, argTypes, args);
    const heap = mod.HEAPF64;
    const status = heap[(response >> 3) + 0];
    const data = heap[(response >> 3) + 1];
    const dataSize = heap[(response >> 3) + 2];
    mod.stackRestore(sp);
    return [status, data, dataSize];
}

function readString(mod, ptr, len) {
    // Copy from shared WASM memory — TextDecoder rejects SharedArrayBuffer views
    return new TextDecoder().decode(mod.HEAPU8.slice(ptr, ptr + len));
}

let module = null;
let connHdl = null;
let wasmMemoryRef = null; // WebAssembly.Memory — captured during init

// All query execution must be async + yield to the event loop between polls.
// When DuckDB runs with multi-threading, pthread sub-workers may call
// pthread_create, which proxies a "spawnThread" message back to the parent
// worker. The parent must service that message via its event loop. If the
// parent is sync-blocked inside a ccall (e.g. duckdb_web_query_run), the proxy
// is never delivered and both threads deadlock waiting on each other.
function yieldEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function collectAndConcatChunks(firstChunk) {
    const chunks = [firstChunk];
    while (true) {
        await yieldEventLoop();
        const [fStatus, fData, fSize] = callSRet(
            module, 'duckdb_web_query_fetch_results', ['number'], [connHdl]
        );
        if (fStatus !== 0 || fData === 0 || fSize === 0) break;
        chunks.push(new Uint8Array(module.HEAPU8.buffer, fData, fSize).slice());
    }
    const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined.buffer;
}

async function runQueryAsync(sql, opts) {
    const reportProgress = opts && opts.reportProgress;
    const allowCancel = opts && opts.allowCancel;

    const [startStatus, startData, startSize] = callSRet(
        module, 'duckdb_web_pending_query_start', ['number', 'string', 'boolean'], [connHdl, sql, false]
    );
    if (startStatus !== 0 && startSize > 0) {
        return { ok: false, error: readString(module, startData, startSize) };
    }
    // Start returned first chunk immediately — concat remaining and return.
    if (startData > 0 && startSize > 0) {
        const firstChunk = new Uint8Array(module.HEAPU8.buffer, startData, startSize).slice();
        return { ok: true, arrowBuffers: [await collectAndConcatChunks(firstChunk)] };
    }

    let lastProgressPost = 0;
    while (true) {
        if (allowCancel && cancelFlag && Atomics.load(cancelFlag, 0) === 1) {
            module.ccall('duckdb_web_pending_query_cancel', 'boolean', ['number', 'string'], [connHdl, '']);
            Atomics.store(cancelFlag, 0, 0);
            return { ok: false, error: 'Query cancelled' };
        }

        await yieldEventLoop();

        const [pollStatus, pollData, pollSize] = callSRet(
            module, 'duckdb_web_pending_query_poll', ['number', 'string'], [connHdl, '']
        );

        if (pollStatus !== 0 && pollSize > 0) {
            return { ok: false, error: readString(module, pollData, pollSize) };
        }

        if (pollData > 0 && pollSize > 0) {
            const firstChunk = new Uint8Array(module.HEAPU8.buffer, pollData, pollSize).slice();
            return { ok: true, arrowBuffers: [await collectAndConcatChunks(firstChunk)] };
        }

        if (reportProgress) {
            const now = performance.now();
            if (now - lastProgressPost >= 150) {
                const pct = module.ccall('duckdb_web_get_query_progress', 'number', ['number'], [connHdl]);
                postMessage({ type: 'progress', percentage: pct });
                lastProgressPost = now;
            }
        }
    }
}

// Send a transient status line to the shell so users can see what init is
// doing while DuckDB warms up. DuckDBShell renders these in-place (one
// rewriting line), so we can stream phase updates without polluting
// terminal history. `done` finalizes the line so subsequent writeln calls
// go on a fresh row.
function postInitStatus(phase, message, done) {
    postMessage({ type: 'init-status', phase: phase, message: message, done: !!done });
}

async function init() {
    const timings = [
        { phase: 'worker-boot', ms: Math.round(T_BEFORE_IMPORT_SCRIPTS - WORKER_T0) },
        { phase: 'importScripts', ms: Math.round(T_AFTER_IMPORT_SCRIPTS - T_BEFORE_IMPORT_SCRIPTS) },
    ];
    let tPrev = T_AFTER_IMPORT_SCRIPTS;
    const mark = (name) => {
        const now = performance.now();
        timings.push({ phase: name, ms: Math.round(now - tPrev) });
        tPrev = now;
    };

    // Wait for the main thread to deliver duckdb-coi.wasm bytes. The main
    // thread races this fetch against catalog load, so in the common case
    // the bytes are already here by the time init() runs.
    postInitStatus('wasm', 'Awaiting DuckDB WASM runtime…');
    const wasmBytes = await wasmBytesPromise;
    mark('await-wasm-bytes');
    console.log('[worker] Loading WASM module...', wasmBytes ? `(${Math.round(wasmBytes.byteLength/(1024*1024))}MB from main thread)` : '(self-fetched)');
    postInitStatus('wasm', wasmBytes ? 'Instantiating DuckDB WASM…' : 'Downloading DuckDB WASM runtime…');

    // Intercept WebAssembly.instantiate and instantiateStreaming to capture the Memory object
    // (Emscripten threads build doesn't expose it on the module)
    function captureMemory(importObject, result) {
        if (wasmMemoryRef) return;
        // Check imports
        if (importObject) {
            for (const ns of Object.values(importObject)) {
                if (ns && typeof ns === 'object') {
                    for (const v of Object.values(ns)) {
                        if (v instanceof WebAssembly.Memory) {
                            wasmMemoryRef = v;
                            console.log('[worker] Captured WebAssembly.Memory from imports');
                            return;
                        }
                    }
                }
            }
        }
        // Check exports
        const exports = result?.instance?.exports || result?.exports;
        if (exports) {
            for (const v of Object.values(exports)) {
                if (v instanceof WebAssembly.Memory) {
                    wasmMemoryRef = v;
                    console.log('[worker] Captured WebAssembly.Memory from exports');
                    return;
                }
            }
        }
    }
    const origInstantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = async function(source, importObject) {
        captureMemory(importObject, null);
        const result = await origInstantiate.call(this, source, importObject);
        captureMemory(null, result);
        return result;
    };
    const origInstantiateStreaming = WebAssembly.instantiateStreaming;
    if (origInstantiateStreaming) {
        WebAssembly.instantiateStreaming = async function(source, importObject) {
            captureMemory(importObject, null);
            const result = await origInstantiateStreaming.call(this, source, importObject);
            captureMemory(null, result);
            return result;
        };
    }

    // WASM base URL: configurable via message from main thread, falls back to relative path.
    // When deployed to Cloudflare Pages, large WASM files (>25MB) are served from R2.
    const wasmBase = self.__wasmBaseUrl || './wasm/';
    // Point pthread sub-workers to a wrapper script that calls DuckDB() factory.
    // With -sMODULARIZE, sub-workers must explicitly invoke the factory to set up
    // the pthread message handler — loading duckdb-coi.js alone just defines it.
    const pthreadWorkerUrl = new URL('./wasm/duckdb-coi-pthread.js', self.location.href).href;
    // The DuckDB-WASM threads build has a bug where extension LOAD fails with
    // "need to see wasm magic number" if the database was opened with
    // maximumThreads > 1 — the parallel task scheduler corrupts the extension
    // binary buffer during loading. Workaround: open with maximumThreads=1,
    // load extensions, then SET threads=N to enable multi-threading for
    // subsequent queries. The pthread pool is still pre-allocated at
    // pthreadPoolSize so query parallelism works after the bump.
    //
    // Thread count: use the value from the main thread (which accounts for
    // Safari defaulting to 1), or fall back to hardwareConcurrency.
    // Localhost dev server uses 1 thread throughout to avoid Vite middleware
    // issues with many concurrent pthread sub-worker fetches.
    const isLocal = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
    const threadCount = isLocal ? 1 : (configuredThreadCount || navigator.hardwareConcurrency || 4);
    console.log('[worker] Thread count:', threadCount, configuredThreadCount ? '(from settings)' : '(default)');
    const duckdbModuleConfig = {
        locateFile: (path) => wasmBase + path,
        mainScriptUrlOrBlob: pthreadWorkerUrl,
        // Note: pthreadPoolSize is hardcoded to 4 in the Emscripten build
        // (duckdb-coi.js initMainThread). This config value is ignored but
        // kept for documentation of intent.
        pthreadPoolSize: threadCount,
    };
    // If the main thread delivered bytes, skip Emscripten's own fetch via the
    // instantiateWasm hook. This is especially important on localhost where
    // the dev server doesn't set cacheable headers, so HTTP cache warming
    // from the main thread is ineffective — bytes-via-transfer is the only
    // reliable way to avoid the worker re-downloading 31 MB.
    //
    // Historical note: we investigated pre-compiling on the main thread via
    // compileStreaming + WebAssembly.Module transfer. It worked but saved no
    // wall-clock time — `DuckDB({...})` is dominated by Emscripten runtime
    // init (LDSO, loadDylibs, pthread handshake), not WASM compile. Reverted.
    if (wasmBytes) {
        duckdbModuleConfig.instantiateWasm = function(imports, successCallback) {
            WebAssembly.instantiate(wasmBytes, imports).then(function(result) {
                successCallback(result.instance, result.module);
            }).catch(function(err) {
                console.error('[worker] instantiateWasm failed:', err);
            });
            return {}; // signals async to Emscripten
        };
    }
    module = await DuckDB(duckdbModuleConfig);
    mark('wasm-instantiate');
    console.log('[worker] Opening database...');
    postInitStatus('open', 'Opening database…');
    const config = JSON.stringify({ allowUnsignedExtensions: true, arrowLosslessConversion: true, maximumThreads: 1, query: { castBigIntToDouble: false } });
    const [openStatus, openData, openSize] = callSRet(module, 'duckdb_web_open', ['string'], [config]);
    if (openStatus !== 0) {
        postMessage({ type: 'log', msg: `Open failed: ${openSize > 0 ? readString(module, openData, openSize) : 'unknown'}`, cls: 'err' });
        return;
    }

    mark('db-open');
    connHdl = module.ccall('duckdb_web_connect', 'number', [], []);

    // Yield to the event loop before running any queries. The Emscripten
    // build hardcodes pthreadPoolSize=4, so four pthread sub-workers are
    // always pre-spawned. Their initialization can send proxy messages
    // (including Embind handle operations) back to the main worker. If we
    // start executing queries before those messages drain, Safari can hit
    // an intermittent "toValue(handle)[...] is not a function" Embind
    // error. A single yield lets the event loop process pending messages.
    await yieldEventLoop();

    // Configure DuckDB settings. Suppress progress bar printing BEFORE
    // enabling progress tracking — otherwise enabling the progress bar
    // causes DuckDB to attach a ProgressBarDisplay that may attempt to
    // call an Embind-bound JS method for rendering. With printing
    // disabled first, that code path is suppressed.
    const workerBase = self.location.href.replace(/\/[^/]*$/, '');
    const initSettings = [
        "SET enable_progress_bar_print=false",
        "SET enable_progress_bar=true",
        "SET autoinstall_known_extensions=false",
        "SET autoload_known_extensions=true",
        "SET arrow_lossless_conversion=true",
        `SET custom_extension_repository='${workerBase}/extensions'`,
    ];
    for (const sql of initSettings) {
        const r = await runQueryAsync(sql);
        if (!r.ok) console.warn('[worker] init setting failed:', sql, r.error);
    }
    mark('settings');

    const exts = ['json', 'icu', 'autocomplete', 'spatial', 'vgi'];
    const failed = [];
    for (let i = 0; i < exts.length; i++) {
        const ext = exts[i];
        postInitStatus('ext:' + ext, `Loading extension ${i + 1}/${exts.length}: ${ext}…`);
        const extStart = performance.now();
        const r = await runQueryAsync(`LOAD '${workerBase}/extensions/v1.5.1/wasm_threads/${ext}.duckdb_extension.wasm'`);
        timings.push({ phase: `load:${ext}`, ms: Math.round(performance.now() - extStart) });
        if (!r.ok) { console.error(`[ext] ${ext}: ${r.error}`); failed.push(ext); }
    }
    tPrev = performance.now();
    if (failed.length > 0) {
        postMessage({ type: 'log', msg: `Failed to load extensions: ${failed.join(', ')}`, cls: 'err' });
    }

    // Bump thread count after extensions are loaded so queries can run in parallel.
    if (threadCount > 1) {
        postInitStatus('threads', `Enabling ${threadCount}-thread execution…`);
        const r = await runQueryAsync(`SET threads=${threadCount}`);
        if (!r.ok) console.error(`[worker] SET threads=${threadCount} failed:`, r.error);
        mark('threads');
    }

    // Log memory info for debugging
    const memBuf = module.HEAPU8.buffer;
    const initialMB = Math.round(memBuf.byteLength / (1024*1024));
    console.log('[worker] WASM ready. Initial memory:', initialMB, 'MB, wasmMemoryRef captured:', !!wasmMemoryRef);

    const totalMs = Math.round(performance.now() - WORKER_T0);
    console.log(`[worker] DuckDB shell ready in ${totalMs}ms`);
    console.table(timings);

    postInitStatus('ready', 'Ready.', true);
    postMessage({ type: 'ready', wasmVersion: WASM_BUILD_VERSION, totalMs: totalMs, timings: timings });
    processPendingMessages();
}

// Queue messages that arrive before the module is ready
var pendingMessages = [];
var moduleReady = false;
// Serialize message handling — async handlers must run one at a time so that
// concurrent queries don't interleave on the same DuckDB connection.
var messageQueue = Promise.resolve();

function enqueueMessage(data) {
    messageQueue = messageQueue.then(() => handleMessage(data)).catch((err) => {
        console.error('[worker] handleMessage error:', err);
        if (self.SentryWorker) {
            self.SentryWorker.captureException(err, { messageType: data && data.type });
        }
    });
}

function processPendingMessages() {
    moduleReady = true;
    for (var i = 0; i < pendingMessages.length; i++) {
        enqueueMessage(pendingMessages[i]);
    }
    pendingMessages = [];
}

onmessage = function(e) {
    const data = e.data;
    // These can be processed before init
    if (data.type === 'init-threads') {
        configuredThreadCount = data.count;
        return;
    }
    if (data.type === 'init-cancel-sab') {
        cancelFlag = new Int32Array(data.sab);
        return;
    }
    if (data.type === 'init-oauth-sab') {
        oauthSAB = data.sab;
        oauthInt32 = new Int32Array(oauthSAB);
        oauthBytes = new Uint8Array(oauthSAB);
        return;
    }
    if (data.type === 'wasm-bytes') {
        preloadedWasmBytes = data.bytes; // ArrayBuffer (transferred) or null
        if (resolveWasmBytes) {
            resolveWasmBytes(preloadedWasmBytes);
            resolveWasmBytes = null;
        }
        return;
    }
    // Queue everything else until module is ready
    if (!moduleReady) {
        pendingMessages.push(data);
        return;
    }
    enqueueMessage(data);
};

async function handleMessage(data) {
    if (data.type === 'complete') {
        const text = data.text;
        const r = await runQueryAsync("CALL sql_auto_complete('" + text.replace(/'/g, "''") + "')");
        if (r.ok && r.arrowBuffers) {
            postMessage({ type: 'completions', arrowBuffers: r.arrowBuffers }, r.arrowBuffers);
        } else {
            postMessage({ type: 'completions', arrowBuffers: null });
        }
        return;
    }
    if (data.type === 'query') {
        const sql = data.sql;
        const qid = data.queryId;
        const r = await runQueryAsync(sql, { reportProgress: true, allowCancel: true });
        if (r.arrowBuffers) {
            postMessage({ type: 'result', ok: true, arrowBuffers: r.arrowBuffers, queryId: qid }, r.arrowBuffers);
        } else {
            postMessage({ type: 'result', ok: r.ok, error: r.error, queryId: qid });
        }
        return;
    }
    if (data.type === 'query-sync') {
        const sql = data.sql;
        const qid = data.queryId;
        const r = await runQueryAsync(sql);
        if (r.arrowBuffers) {
            postMessage({ type: 'result', ok: true, arrowBuffers: r.arrowBuffers, queryId: qid }, r.arrowBuffers);
        } else {
            postMessage({ type: 'result', ok: r.ok, error: r.error, queryId: qid });
        }
        return;
    }
    if (data.type === 'snapshot') {
        // Copy WASM linear memory and send as Transferable
        const memBuf = module.HEAPU8.buffer;
        const copy = new Uint8Array(memBuf.byteLength);
        copy.set(new Uint8Array(memBuf));
        postMessage(
            { type: 'snapshot', memory: copy.buffer, size: memBuf.byteLength, connHdl: connHdl, wasmVersion: WASM_BUILD_VERSION },
            [copy.buffer]
        );
        return;
    }
    if (data.type === 'restore') {
        try {
            const snapshot = new Uint8Array(data.memory);
            const currentSize = module.HEAPU8.buffer.byteLength;
            const snapshotMB = Math.round(data.size / (1024*1024));
            const currentMB = Math.round(currentSize / (1024*1024));
            console.log('[restore] Snapshot size:', snapshotMB, 'MB, current WASM memory:', currentMB, 'MB, delta:', snapshotMB - currentMB, 'MB');
            if (data.size > currentSize) {
                const wasmMem = wasmMemoryRef || module.wasmMemory || module.asm?.memory;
                if (!wasmMem) {
                    console.error('[restore] Cannot grow: no WebAssembly.Memory object found');
                    postMessage({ type: 'log', msg: 'Restore failed: snapshot (' + snapshotMB + ' MB) exceeds WASM memory (' + currentMB + ' MB) and memory cannot be resized', cls: 'err' });
                    return;
                }

                // Grow in a loop — SharedArrayBuffer may need multiple grows
                const targetSize = data.size;
                let attempts = 0;
                while (wasmMem.buffer.byteLength < targetSize && attempts < 50) {
                    const remaining = targetSize - wasmMem.buffer.byteLength;
                    const pages = Math.ceil(remaining / 65536);
                    console.log('[restore] Grow attempt', attempts + 1, ': need', pages, 'pages, buffer is', wasmMem.buffer.byteLength, 'target', targetSize);
                    try {
                        const oldPages = wasmMem.grow(pages);
                        console.log('[restore] Grew from', oldPages, 'pages, buffer now', wasmMem.buffer.byteLength);
                    } catch (growErr) {
                        console.error('[restore] wasmMemory.grow failed:', growErr.message);
                        postMessage({ type: 'log', msg: 'Restore failed: could not grow memory (snapshot: ' + snapshotMB + ' MB, current: ' + Math.round(wasmMem.buffer.byteLength / (1024*1024)) + ' MB)', cls: 'err' });
                        return;
                    }
                    attempts++;
                }

                // Update Emscripten's heap views to point at the new buffer
                if (module.updateMemoryViews) module.updateMemoryViews();
                else if (module._emscripten_notify_memory_growth) module._emscripten_notify_memory_growth(0);
                // HEAPU8 may still reference old buffer — reconstruct from Memory
                if (module.HEAPU8.buffer !== wasmMem.buffer) {
                    console.log('[restore] Rebuilding HEAPU8 from grown Memory buffer');
                    module.HEAPU8 = new Uint8Array(wasmMem.buffer);
                    module.HEAPF64 = new Float64Array(wasmMem.buffer);
                }

                if (module.HEAPU8.buffer.byteLength < data.size) {
                    postMessage({ type: 'log', msg: 'Restore failed: memory grew to ' + Math.round(module.HEAPU8.buffer.byteLength / (1024*1024)) + ' MB but snapshot needs ' + snapshotMB + ' MB', cls: 'err' });
                    return;
                }
                console.log('[restore] Memory grown successfully to', Math.round(module.HEAPU8.buffer.byteLength / (1024*1024)), 'MB');
            }
            module.HEAPU8.set(snapshot);
            connHdl = data.connHdl;
            postMessage({ type: 'restored' });
        } catch (err) {
            postMessage({ type: 'log', msg: 'Restore failed: ' + err.message, cls: 'err' });
        }
        return;
    }
};

init().catch(function(err) {
    console.error('[worker] init() failed:', err);
    postMessage({ type: 'log', msg: 'DuckDB initialization failed: ' + (err.message || err), cls: 'err' });
    if (self.SentryWorker) {
        self.SentryWorker.captureException(err, { phase: 'init' });
    }
});
