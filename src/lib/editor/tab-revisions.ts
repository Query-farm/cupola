/**
 * Revision history of each Query Editor tab: snapshots of the whole buffer,
 * taken when the query runs and around every whole-buffer replacement (Ask AI
 * applying SQL, Restore, Format), so no version that existed only in the
 * editor's undo stack is lost. That stack goes with the page; this doesn't.
 *
 * Separate from query history (`query-history.ts`), which is a log of what
 * ran from every surface. That log shares one cap across the shell and the
 * AI panels, so a busy shell session used to push a tab's past versions out.
 * Here each tab has its own key and its own cap, and is deleted with the tab.
 *
 * Each distinct text is stored once (`blobs`, by content hash), so re-running
 * a long query costs one revision entry, not another copy.
 */

/** How a revision came about. `edit`: the text as you left it, captured just
 *  before something replaced it. */
export type RevisionKind = "edit" | "run" | "ai" | "restore" | "format";

export interface RunOutcome {
  success: boolean;
  rowCount?: number;
  error?: string;
  ms: number;
  /** Runs of this exact text folded into the revision. */
  runs?: number;
}

export interface TabRevision {
  id: number;
  at: number;
  kind: RevisionKind;
  hash: string;
  /** For a run: the statement or selection that ran, when not the whole text. */
  statement?: string;
  outcome?: RunOutcome;
}

export interface TabRevisions {
  /** Newest first. */
  revisions: TabRevision[];
  blobs: Record<string, string>;
}

export const REVISIONS_PER_TAB = 50;
const KEY_PREFIX = "cupola.editor-revisions.v1::";
const key = (serviceUrl: string, docId: string) => `${KEY_PREFIX}${serviceUrl}::${docId}`;
const EMPTY: TabRevisions = { revisions: [], blobs: {} };

/** FNV-1a, plus the length: enough to tell a tab's versions apart. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}-${text.length}`;
}

const cache = new Map<string, TabRevisions>();
const listeners = new Set<() => void>();

function isRevisions(value: unknown): value is TabRevisions {
  const v = value as TabRevisions;
  return !!v && Array.isArray(v.revisions) && !!v.blobs && typeof v.blobs === "object";
}

export function loadTabRevisions(serviceUrl: string, docId: string): TabRevisions {
  const k = key(serviceUrl, docId);
  const hit = cache.get(k);
  if (hit) return hit;
  let value = EMPTY;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(k);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (isRevisions(parsed)) value = parsed;
  } catch { /* Corrupt or blocked storage: start empty. */ }
  cache.set(k, value);
  return value;
}

/** Keep the newest `limit` revisions and only the blobs they use. */
function trim(value: TabRevisions, limit: number): TabRevisions {
  const revisions = value.revisions.slice(0, limit);
  const used = new Set(revisions.map((r) => r.hash));
  const blobs: Record<string, string> = {};
  for (const h of used) if (value.blobs[h] !== undefined) blobs[h] = value.blobs[h];
  return { revisions, blobs };
}

/** Write, halving the history until it fits; memory keeps it whole either way. */
function save(serviceUrl: string, docId: string, value: TabRevisions) {
  const k = key(serviceUrl, docId);
  cache.set(k, value);
  for (const l of listeners) l();
  if (typeof localStorage === "undefined") return;
  let kept = value;
  for (;;) {
    try {
      if (kept.revisions.length) localStorage.setItem(k, JSON.stringify(kept));
      else localStorage.removeItem(k);
      return;
    } catch {
      if (kept.revisions.length <= 1) return;
      kept = trim(kept, Math.floor(kept.revisions.length / 2));
    }
  }
}

/**
 * Snapshot a tab's text. Text identical to the latest revision adds nothing:
 * a run of it updates that revision's outcome (counting the run), anything
 * else is skipped. Blank text is never recorded.
 */
export function recordRevision(
  serviceUrl: string,
  docId: string,
  text: string,
  kind: RevisionKind,
  extra: { statement?: string; outcome?: RunOutcome } = {},
  now = Date.now(),
): void {
  if (!text.trim()) return;
  const current = loadTabRevisions(serviceUrl, docId);
  const hash = textHash(text);
  const [latest, ...rest] = current.revisions;
  if (latest && latest.hash === hash) {
    if (kind !== "run") return;
    const runs = latest.kind === "run" && latest.outcome ? (latest.outcome.runs ?? 1) + 1 : 1;
    const updated: TabRevision = {
      ...latest,
      at: now,
      // Your edits, then a run of them: one revision that ran.
      kind: latest.kind === "edit" ? "run" : latest.kind,
      ...(extra.statement ? { statement: extra.statement } : {}),
      ...(extra.outcome ? { outcome: { ...extra.outcome, runs } } : {}),
    };
    save(serviceUrl, docId, { ...current, revisions: [updated, ...rest] });
    return;
  }
  const id = Math.max(now, (latest?.id ?? 0) + 1);
  const revision: TabRevision = { id, at: now, kind, hash, ...extra };
  save(serviceUrl, docId, trim({ revisions: [revision, ...current.revisions], blobs: { ...current.blobs, [hash]: text } }, REVISIONS_PER_TAB));
}

/** A revision's text ("" if its blob is missing). */
export function revisionText(value: TabRevisions, revision: TabRevision): string {
  return value.blobs[revision.hash] ?? "";
}

/** Forget a tab's revisions (the tab was deleted). */
export function deleteTabRevisions(serviceUrl: string, docId: string): void {
  save(serviceUrl, docId, EMPTY);
}

export function subscribeTabRevisions(listener: () => void): () => void {
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
