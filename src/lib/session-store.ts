/**
 * Session persistence via IndexedDB.
 *
 * Stores compressed DuckDB WASM memory snapshots keyed by service URL,
 * enabling save/restore of in-memory tables, query history, and AI conversations.
 */

const DB_NAME = "vgi-sessions";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const AUTOSAVE_NAME = "__autosave__";

export interface SessionInfo {
  id: string;
  name: string;
  serviceUrl: string;
  timestamp: number;
  wasmVersion: string;
  sizeBytes: number;
}

export interface SavedSession extends SessionInfo {
  memoryBlob: Blob;
  connHdl: number;
  queryHistory: any[];
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("serviceUrl", "serviceUrl", { unique: false });
        store.createIndex("serviceUrl_name", ["serviceUrl", "name"], { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

async function compress(data: ArrayBuffer): Promise<Blob> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function decompress(blob: Blob): Promise<ArrayBuffer> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List sessions for a service URL (lightweight — no memory blobs). */
export async function listSessions(serviceUrl: string): Promise<SessionInfo[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readonly");
    const index = store.index("serviceUrl");
    const req = index.getAll(serviceUrl);
    req.onsuccess = () => {
      const sessions: SessionInfo[] = (req.result || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        serviceUrl: s.serviceUrl,
        timestamp: s.timestamp,
        wasmVersion: s.wasmVersion,
        sizeBytes: s.sizeBytes || 0,
      }));
      sessions.sort((a, b) => b.timestamp - a.timestamp);
      db.close();
      resolve(sessions);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Save a session. Overwrites if same serviceUrl + name exists. */
export async function saveSession(
  serviceUrl: string,
  name: string,
  wasmVersion: string,
  memory: ArrayBuffer,
  connHdl: number,
  queryHistory: any[] = [],
): Promise<string> {
  const compressed = await compress(memory);
  const id = `${serviceUrl}::${name}`;
  const session = {
    id,
    name,
    serviceUrl,
    timestamp: Date.now(),
    wasmVersion,
    sizeBytes: compressed.size,
    memoryBlob: compressed,
    connHdl,
    queryHistory,
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readwrite");
    const req = store.put(session);
    req.onsuccess = () => { db.close(); resolve(id); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Load a session by id. Decompresses memory blob. */
export async function loadSession(id: string): Promise<SavedSession | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readonly");
    const req = store.get(id);
    req.onsuccess = () => {
      db.close();
      if (!req.result) { resolve(null); return; }
      resolve(req.result as SavedSession);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Delete a session by id. */
export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readwrite");
    const req = store.delete(id);
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Get the autosave session for a service URL. */
export async function getAutoSave(serviceUrl: string): Promise<SavedSession | null> {
  return loadSession(`${serviceUrl}::${AUTOSAVE_NAME}`);
}

/** Save an autosave session. */
export async function saveAutoSave(
  serviceUrl: string,
  wasmVersion: string,
  memory: ArrayBuffer,
  connHdl: number,
  queryHistory: any[] = [],
): Promise<void> {
  await saveSession(serviceUrl, AUTOSAVE_NAME, wasmVersion, memory, connHdl, queryHistory);
}

/** Decompress a session's memory blob to an ArrayBuffer. */
export async function decompressMemory(session: SavedSession): Promise<ArrayBuffer> {
  return decompress(session.memoryBlob);
}

export { AUTOSAVE_NAME };
