// DuckDB-WASM Worker — runs DuckDB in a Web Worker where sync XHR and SAB work.

var WASM_BUILD_VERSION = "duckdb-1.5.1-vgi-coi-20260409";

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

function runQuery(sql) {
    const [qStatus, qData, qSize] = callSRet(
        module, 'duckdb_web_query_run', ['number', 'string'], [connHdl, sql]
    );
    if (qStatus !== 0 && qSize > 0) {
        return { ok: false, error: readString(module, qData, qSize) };
    }
    return { ok: true, status: qStatus };
}

function runQueryWithResults(sql) {
    const [qStatus, qData, qSize] = callSRet(
        module, 'duckdb_web_query_run', ['number', 'string'], [connHdl, sql]
    );
    if (qStatus !== 0 && qSize > 0) {
        return { ok: false, error: readString(module, qData, qSize) };
    }
    if (qData > 0 && qSize > 0) {
        const arrowBuffer = new Uint8Array(qSize);
        arrowBuffer.set(new Uint8Array(module.HEAPU8.buffer, qData, qSize));
        return { ok: true, arrowBuffers: [arrowBuffer.buffer] };
    }
    return { ok: true };
}

function runQueryPolling(sql) {
    // Start pending query (allow_stream_result = false)
    const [startStatus, startData, startSize] = callSRet(
        module, 'duckdb_web_pending_query_start', ['number', 'string', 'boolean'], [connHdl, sql, false]
    );
    if (startStatus !== 0 && startSize > 0) {
        return { ok: false, error: readString(module, startData, startSize) };
    }
    // Start returned first chunk — collect all IPC messages and concatenate
    if (startData > 0 && startSize > 0) {
        const chunks = [new Uint8Array(module.HEAPU8.buffer, startData, startSize).slice()];
        // Fetch remaining IPC messages (record batches)
        while (true) {
            const [fStatus, fData, fSize] = callSRet(
                module, 'duckdb_web_query_fetch_results', ['number'], [connHdl]
            );
            if (fStatus !== 0 || fData === 0 || fSize === 0) break;
            chunks.push(new Uint8Array(module.HEAPU8.buffer, fData, fSize).slice());
        }
        // Concatenate all chunks into a single Arrow IPC stream
        const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { ok: true, arrowBuffers: [combined.buffer] };
    }

    // Poll until result or cancellation
    var lastProgressPost = 0;
    while (true) {
        if (cancelFlag && Atomics.load(cancelFlag, 0) === 1) {
            module.ccall('duckdb_web_pending_query_cancel', 'boolean', ['number', 'string'], [connHdl, '']);
            Atomics.store(cancelFlag, 0, 0);
            return { ok: false, error: 'Query cancelled' };
        }

        const [pollStatus, pollData, pollSize] = callSRet(
            module, 'duckdb_web_pending_query_poll', ['number', 'string'], [connHdl, '']
        );

        if (pollStatus !== 0 && pollSize > 0) {
            return { ok: false, error: readString(module, pollData, pollSize) };
        }

        // Poll returned result — collect and concatenate IPC messages
        if (pollData > 0 && pollSize > 0) {
            const chunks = [new Uint8Array(module.HEAPU8.buffer, pollData, pollSize).slice()];
            while (true) {
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
            return { ok: true, arrowBuffers: [combined.buffer] };
        }

        // Not ready yet — report progress (throttled to ~7 updates/sec)
        var now = performance.now();
        if (now - lastProgressPost >= 150) {
            var pct = module.ccall('duckdb_web_get_query_progress', 'number', ['number'], [connHdl]);
            postMessage({ type: 'progress', percentage: pct });
            lastProgressPost = now;
        }
    }
}


// Fallback: use synchronous query_run for statements that don't need cancellation
function runStatement(sql) {
    return runQuery(sql);
}

async function init() {
    // Loading messages logged to console only — keep terminal clean
    console.log('[worker] Loading WASM module...');

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
    module = await DuckDB({
        locateFile: (path) => wasmBase + path,
        mainScriptUrlOrBlob: pthreadWorkerUrl,
        pthreadPoolSize: 1,
    });
    console.log('[worker] Opening database...');
    const config = JSON.stringify({ allowUnsignedExtensions: true, arrowLosslessConversion: true, maximumThreads: 1, query: { castBigIntToDouble: false } });
    const [openStatus, openData, openSize] = callSRet(module, 'duckdb_web_open', ['string'], [config]);
    if (openStatus !== 0) {
        postMessage({ type: 'log', msg: `Open failed: ${openSize > 0 ? readString(module, openData, openSize) : 'unknown'}`, cls: 'err' });
        return;
    }

    connHdl = module.ccall('duckdb_web_connect', 'number', [], []);

    runQuery("SET enable_progress_bar=true");
    runQuery("SET enable_progress_bar_print=false");
    runQuery("SET autoinstall_known_extensions=false");
    runQuery("SET autoload_known_extensions=true");
    runQuery("SET arrow_lossless_conversion=true");
    const workerBase = self.location.href.replace(/\/[^/]*$/, '');
    runQuery(`SET custom_extension_repository='${workerBase}/extensions'`);

    const exts = ['json', 'icu', 'autocomplete', 'spatial', 'vgi'];
    const failed = [];
    for (const ext of exts) {
        const r = runQuery(`LOAD '${workerBase}/extensions/v1.5.1/wasm_threads/${ext}.duckdb_extension.wasm'`);
        if (!r.ok) { console.error(`[ext] ${ext}: ${r.error}`); failed.push(ext); }
    }
    if (failed.length > 0) {
        postMessage({ type: 'log', msg: `Failed to load extensions: ${failed.join(', ')}`, cls: 'err' });
    }

    // Log memory info for debugging
    const memBuf = module.HEAPU8.buffer;
    const initialMB = Math.round(memBuf.byteLength / (1024*1024));
    console.log('[worker] WASM ready. Initial memory:', initialMB, 'MB, wasmMemoryRef captured:', !!wasmMemoryRef);

    postMessage({ type: 'ready', wasmVersion: WASM_BUILD_VERSION });
    processPendingMessages();
}

// Queue messages that arrive before the module is ready
var pendingMessages = [];
var moduleReady = false;

function processPendingMessages() {
    moduleReady = true;
    for (var i = 0; i < pendingMessages.length; i++) {
        handleMessage(pendingMessages[i]);
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
    handleMessage(data);
};

function handleMessage(data) {
    if (data.type === 'complete') {
        const text = data.text;
        const r = runQueryWithResults("CALL sql_auto_complete('" + text.replace(/'/g, "''") + "')");
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
        const r = runQueryPolling(sql);
        if (r.arrowBuffers) {
            postMessage({ type: 'result', ok: true, arrowBuffers: r.arrowBuffers, queryId: qid }, r.arrowBuffers);
        } else {
            postMessage({ type: 'result', ok: r.ok, error: r.error, queryId: qid });
        }
        return;
    }
    if (data.type === 'query-sync') {
        // Synchronous query — returns single Arrow IPC buffer (not streaming chunks)
        const sql = data.sql;
        const qid = data.queryId;
        const r = runQueryWithResults(sql);
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
