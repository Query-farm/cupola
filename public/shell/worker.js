// DuckDB-WASM Worker — runs DuckDB in a Web Worker where sync XHR and SAB work.

// Append the cupola release version (extracted from /vX.Y.Z/ in self.location)
// so IndexedDB snapshots from prior releases are not restored into a worker
// whose JS-side runtime state differs. The duckdb-coi.wasm bytes can be
// identical across releases, but a snapshot also captures function-table
// indices populated by Embind at startup — those depend on the worker.js
// init order, so a snapshot is only safe to restore in the same release.
var RELEASE_VERSION = self.location.pathname.match(/\/v(\d+\.\d+\.\d+)\//)?.[1] || 'unversioned';
var WASM_BUILD_VERSION = "duckdb-1.5.1-vgi-coi-20260409-r" + RELEASE_VERSION;

// OAuth SAB state — initialized from main thread
var oauthSAB = null;
var oauthInt32 = null;
var oauthBytes = null;

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

importScripts('./wasm/duckdb-coi.js');

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
    // Loading messages logged to console only — keep terminal clean
    console.log('[worker] Loading WASM module...');
    postInitStatus('wasm', 'Downloading DuckDB WASM runtime…');

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
    // Localhost dev server uses 1 thread throughout to avoid Vite middleware
    // issues with many concurrent pthread sub-worker fetches.
    const isLocal = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
    const threadCount = isLocal ? 1 : (navigator.hardwareConcurrency || 4);
    module = await DuckDB({
        locateFile: (path) => wasmBase + path,
        mainScriptUrlOrBlob: pthreadWorkerUrl,
        pthreadPoolSize: threadCount,
    });
    console.log('[worker] Opening database...');
    postInitStatus('open', 'Opening database…');
    const config = JSON.stringify({ allowUnsignedExtensions: true, arrowLosslessConversion: true, maximumThreads: 1, query: { castBigIntToDouble: false } });
    const [openStatus, openData, openSize] = callSRet(module, 'duckdb_web_open', ['string'], [config]);
    if (openStatus !== 0) {
        postMessage({ type: 'log', msg: `Open failed: ${openSize > 0 ? readString(module, openData, openSize) : 'unknown'}`, cls: 'err' });
        return;
    }

    connHdl = module.ccall('duckdb_web_connect', 'number', [], []);

    // Enable DuckDB's built-in progress tracking. This populates the
    // counter that duckdb_web_get_query_progress reads, which we poll from
    // runQueryAsync and post back as {type:'progress'} messages. Setting
    // enable_progress_bar_print=false suppresses the C++ side's stderr
    // output — we render the bar ourselves in DuckDBShell.renderProgressBar.
    await runQueryAsync("SET enable_progress_bar=true");
    await runQueryAsync("SET enable_progress_bar_print=false");
    await runQueryAsync("SET autoinstall_known_extensions=false");
    await runQueryAsync("SET autoload_known_extensions=true");
    await runQueryAsync("SET arrow_lossless_conversion=true");
    const workerBase = self.location.href.replace(/\/[^/]*$/, '');
    await runQueryAsync(`SET custom_extension_repository='${workerBase}/extensions'`);

    const exts = ['json', 'icu', 'autocomplete', 'spatial', 'vgi'];
    const failed = [];
    for (let i = 0; i < exts.length; i++) {
        const ext = exts[i];
        postInitStatus('ext:' + ext, `Loading extension ${i + 1}/${exts.length}: ${ext}…`);
        const r = await runQueryAsync(`LOAD '${workerBase}/extensions/v1.5.1/wasm_threads/${ext}.duckdb_extension.wasm'`);
        if (!r.ok) { console.error(`[ext] ${ext}: ${r.error}`); failed.push(ext); }
    }
    if (failed.length > 0) {
        postMessage({ type: 'log', msg: `Failed to load extensions: ${failed.join(', ')}`, cls: 'err' });
    }

    // Bump thread count after extensions are loaded so queries can run in parallel.
    if (threadCount > 1) {
        postInitStatus('threads', `Enabling ${threadCount}-thread execution…`);
        const r = await runQueryAsync(`SET threads=${threadCount}`);
        if (!r.ok) console.error(`[worker] SET threads=${threadCount} failed:`, r.error);
    }

    // Log memory info for debugging
    const memBuf = module.HEAPU8.buffer;
    const initialMB = Math.round(memBuf.byteLength / (1024*1024));
    console.log('[worker] WASM ready. Initial memory:', initialMB, 'MB, wasmMemoryRef captured:', !!wasmMemoryRef);

    postInitStatus('ready', 'Ready.', true);
    postMessage({ type: 'ready', wasmVersion: WASM_BUILD_VERSION });
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

init();
