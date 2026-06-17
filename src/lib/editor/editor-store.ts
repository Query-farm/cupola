/**
 * localStorage-backed document model for the SQL editor. Only the SQL text is
 * persisted (results are ephemeral / re-run on demand). Separate from the
 * settings store so editor docs don't bloat the settings blob.
 */

export interface EditorDoc {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
  updatedAt: number;
}

export interface EditorState {
  version: 1;
  docs: EditorDoc[];
  activeId: string | null;
}

/** Legacy (unscoped) key — predates per-server scoping. Migrated on first
 *  load for a server, then removed. */
const LEGACY_KEY = "vgi-sql-editor-docs";

/** Saved queries are scoped to the connected VGI server so each server keeps
 *  its own set of tabs. Falls back to the legacy unscoped key when no service
 *  is provided (e.g. unit tests). */
function storageKey(serviceUrl?: string): string {
  return serviceUrl ? `${LEGACY_KEY}::${serviceUrl}` : LEGACY_KEY;
}

/** Best-effort UUID — crypto.randomUUID where available, else a timestamp+rand fallback. */
export function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedDoc(): EditorDoc {
  const now = Date.now();
  return { id: newId(), name: "Query 1", sql: "", createdAt: now, updatedAt: now };
}

function freshState(): EditorState {
  const doc = seedDoc();
  return { version: 1, docs: [doc], activeId: doc.id };
}

/** Load persisted editor state for the given server, healing/seeding as
 *  needed. On first load for a server, adopts any legacy unscoped docs (then
 *  removes them) so existing queries aren't lost. Never throws. */
export function loadEditorState(serviceUrl?: string): EditorState {
  if (typeof localStorage === "undefined") return freshState();
  try {
    const key = storageKey(serviceUrl);
    let raw = localStorage.getItem(key);
    // One-time migration: the first server to load adopts the legacy
    // unscoped docs, then the legacy key is cleared.
    if (!raw && serviceUrl) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(LEGACY_KEY);
        raw = legacy;
      }
    }
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as Partial<EditorState>;
    const docs = Array.isArray(parsed.docs)
      ? parsed.docs.filter((d): d is EditorDoc => !!d && typeof d.id === "string" && typeof d.sql === "string")
      : [];
    if (docs.length === 0) return freshState();
    const activeId = docs.some((d) => d.id === parsed.activeId) ? parsed.activeId! : docs[0].id;
    return { version: 1, docs, activeId };
  } catch {
    return freshState();
  }
}

/** Persist editor state for the given server. Never throws. */
export function saveEditorState(state: EditorState, serviceUrl?: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(serviceUrl), JSON.stringify(state));
  } catch {}
}

/** Append a new empty (or seeded) document and make it active. */
export function addDoc(state: EditorState, sql = "", name?: string): EditorState {
  const now = Date.now();
  const n = name ?? nextName(state.docs);
  const doc: EditorDoc = { id: newId(), name: n, sql, createdAt: now, updatedAt: now };
  return { ...state, docs: [...state.docs, doc], activeId: doc.id };
}

/** Remove a document; ensures at least one doc remains and a valid active id. */
export function removeDoc(state: EditorState, id: string): EditorState {
  let docs = state.docs.filter((d) => d.id !== id);
  if (docs.length === 0) docs = [seedDoc()];
  let activeId = state.activeId;
  if (activeId === id) {
    const removedIdx = state.docs.findIndex((d) => d.id === id);
    const fallback = docs[Math.max(0, Math.min(removedIdx, docs.length - 1))];
    activeId = fallback?.id ?? docs[0].id;
  }
  return { ...state, docs, activeId };
}

export function renameDoc(state: EditorState, id: string, name: string): EditorState {
  return {
    ...state,
    docs: state.docs.map((d) => (d.id === id ? { ...d, name, updatedAt: Date.now() } : d)),
  };
}

export function updateDocSql(state: EditorState, id: string, sql: string): EditorState {
  return {
    ...state,
    docs: state.docs.map((d) => (d.id === id ? { ...d, sql, updatedAt: Date.now() } : d)),
  };
}

export function setActive(state: EditorState, id: string): EditorState {
  if (!state.docs.some((d) => d.id === id)) return state;
  return { ...state, activeId: id };
}

/** "Query N" using the smallest free N not already taken by a default-named doc. */
function nextName(docs: EditorDoc[]): string {
  const used = new Set<number>();
  for (const d of docs) {
    const m = /^Query (\d+)$/.exec(d.name);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `Query ${n}`;
}
