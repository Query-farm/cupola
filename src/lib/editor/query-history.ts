/**
 * Query history: every query the shell, the Query Editor and the AI surfaces
 * ran, kept in localStorage per workspace so it survives a reload. Read in
 * the editor's History panel, which can also list every workspace's
 * (`loadAllQueryHistories`).
 *
 * Keyed `cupola.query-history.v1::<workspace id>` since multi-catalog phase 2;
 * before that, by the default catalog's service URL. A workspace with no list
 * of its own yet reads its legacy URL's list (`legacy-scope.ts`), read-only:
 * the first query it records starts its own list from that one.
 *
 * It used to live only in React state behind its own top-level tab, so it
 * covered the current session and nothing else — which is when it was needed
 * least. Every recorder still goes through `ui.addQueryHistoryEntry`
 * (`CatalogApp` points it here), so nothing that records a query knows where
 * it is kept.
 */
import type { QueryHistoryEntry } from "@/lib/shell-bridge";
import { legacyScopeFor } from "@/lib/workspace/legacy-scope";

/** Entries kept per server; the oldest go first. */
export const QUERY_HISTORY_LIMIT = 300;
const KEY_PREFIX = "cupola.query-history.v1::";
const key = (serviceUrl: string) => `${KEY_PREFIX}${serviceUrl}`;

const cache = new Map<string, QueryHistoryEntry[]>();
const listeners = new Set<() => void>();
const EMPTY: QueryHistoryEntry[] = [];

function isEntry(value: unknown): value is QueryHistoryEntry {
  const entry = value as QueryHistoryEntry;
  return !!entry && typeof entry.id === "number" && typeof entry.sql === "string" && typeof entry.timestamp === "number";
}

/** Newest first. Never throws: unreadable storage is an empty history. */
export function loadQueryHistory(scope: string): QueryHistoryEntry[] {
  const cached = cache.get(scope);
  if (cached) return cached;
  let entries: QueryHistoryEntry[] = EMPTY;
  try {
    let raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key(scope));
    const legacy = legacyScopeFor(scope);
    if (raw === null && legacy && typeof localStorage !== "undefined") raw = localStorage.getItem(key(legacy));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) entries = parsed.filter(isEntry);
  } catch { /* Corrupt or blocked storage: start empty. */ }
  cache.set(scope, entries);
  return entries;
}

/** Every stored list whose scope `isScope` accepts (the workspace ids this
 *  browser knows), newest entry first, each entry labelled with its scope. */
export function loadAllQueryHistories(isScope: (scope: string) => boolean): { scope: string; entry: QueryHistoryEntry }[] {
  const all: { scope: string; entry: QueryHistoryEntry }[] = [];
  if (typeof localStorage === "undefined") return all;
  const scopes = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(KEY_PREFIX) && isScope(k.slice(KEY_PREFIX.length))) scopes.add(k.slice(KEY_PREFIX.length));
    }
  } catch { return all; }
  for (const scope of scopes) for (const entry of loadQueryHistory(scope)) all.push({ scope, entry });
  return all.sort((a, b) => b.entry.timestamp - a.entry.timestamp);
}

/** Write, shedding the oldest half until it fits; the in-memory list stays whole
 *  either way, so a full storage only costs history across reloads. */
function save(serviceUrl: string, entries: QueryHistoryEntry[]) {
  cache.set(serviceUrl, entries);
  for (const listener of listeners) listener();
  if (typeof localStorage === "undefined") return;
  let kept = entries;
  for (;;) {
    try {
      if (kept.length) localStorage.setItem(key(serviceUrl), JSON.stringify(kept));
      else localStorage.removeItem(key(serviceUrl));
      return;
    } catch {
      if (kept.length <= 1) return;
      kept = kept.slice(0, Math.floor(kept.length / 2));
    }
  }
}

const sameQuery = (a: QueryHistoryEntry, b: QueryHistoryEntry) =>
  a.sql.trim() === b.sql.trim() && a.source === b.source && !a.conversationId && !b.conversationId && a.success === b.success
  && a.docId === b.docId && (a.docSql ?? a.sql).trim() === (b.docSql ?? b.sql).trim();

/** The text a run left in its tab: the whole document when recorded. */
export const runSnapshot = (entry: QueryHistoryEntry) => entry.docSql ?? entry.sql;

/** Record a query. Running the same query again straight after replaces the
 *  previous entry and counts the run, so re-running in a loop doesn't bury
 *  everything else. */
export function addQueryHistoryEntry(serviceUrl: string, entry: QueryHistoryEntry) {
  if (!entry.sql.trim()) return;
  const entries = loadQueryHistory(serviceUrl);
  const [latest, ...rest] = entries;
  // Recorders stamp ids with Date.now(), which two queries in one millisecond share.
  const id = Math.max(entry.id, ...entries.slice(0, 1).map((item) => item.id + 1));
  if (latest && sameQuery(latest, entry)) {
    save(serviceUrl, [{ ...entry, id, runs: (latest.runs ?? 1) + 1 }, ...rest]);
    return;
  }
  save(serviceUrl, [{ ...entry, id }, ...entries].slice(0, QUERY_HISTORY_LIMIT));
}

export function removeQueryHistoryEntry(serviceUrl: string, id: number) {
  save(serviceUrl, loadQueryHistory(serviceUrl).filter((entry) => entry.id !== id));
}

export function clearQueryHistory(serviceUrl: string) {
  save(serviceUrl, []);
}

/** For `useSyncExternalStore`. Another tab's writes arrive as `storage` events. */
export function subscribeQueryHistory(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith(KEY_PREFIX)) return;
    cache.clear();
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
