import { z } from 'zod';
import type { EvidenceReport } from './reports';

/** A report's revision history: every saved version, what changed and who changed it.
 *
 *  Each revision names its fields' values by content hash, and each value is stored once in
 *  `blobs`, so a save costs only the fields it changed. Hashes also make histories merge
 *  exactly: importing a report file unions two histories' revisions and blobs, and every
 *  revision still resolves to the report it was, whichever chain it came from. */
export const REVISION_FIELDS = ['title', 'source', 'setupSql', 'parameters', 'values', 'drillPaths', 'appearance', 'semanticDatasets', 'pivots'] as const;
export type RevisionField = typeof REVISION_FIELDS[number];
export const REVISION_FIELD_LABELS: Record<RevisionField, string> = {
  title: 'Title', source: 'Document', setupSql: 'Dataset SQL', parameters: 'Parameters', values: 'Parameter values',
  drillPaths: 'Drill paths', appearance: 'Appearance', semanticDatasets: 'Semantic datasets', pivots: 'Pivot views',
};

/** Who made a revision: the reader saving their edits, the report agent (its proposals applied and
 *  saved), a restore of an earlier revision, an import from a report file, or the version saved
 *  before history was kept. */
export const REVISION_KINDS = ['edit', 'agent', 'restore', 'import', 'baseline'] as const;
export type RevisionKind = typeof REVISION_KINDS[number];

const revisionSchema = z.object({
  id: z.string().min(1),
  savedAt: z.number(),
  kind: z.enum(REVISION_KINDS),
  label: z.string(),
  /** The agent's proposal summaries this save kept, in the order they were applied. */
  agentSummaries: z.array(z.string()).optional(),
  /** The reader also edited the report by hand, around the agent's proposals. */
  alsoEdited: z.boolean().optional(),
  /** Fields that differ from the previous revision (none for the first). */
  changed: z.array(z.enum(REVISION_FIELDS)),
  /** Autosaved edits of one editing session, which later autosaves in the session extend. */
  session: z.string().optional(),
  /** When a revision that later autosaves extended was first saved. */
  startedAt: z.number().optional(),
  /** Each field's value, by blob hash; a field the report doesn't have is absent. */
  fields: z.object(Object.fromEntries(REVISION_FIELDS.map(field => [field, z.string().optional()])) as Record<RevisionField, z.ZodOptional<z.ZodString>>),
});
export const historySchema = z.object({
  revisions: z.array(revisionSchema),
  blobs: z.record(z.string(), z.string()),
});
export type Revision = z.infer<typeof revisionSchema>;
export type ReportHistory = z.infer<typeof historySchema>;
export const emptyHistory = (): ReportHistory => ({ revisions: [], blobs: {} });

/** cyrb53, with the length: a collision between two values of one report is not a practical concern. */
function hash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}-${text.length.toString(36)}`;
}

type Spec = Pick<EvidenceReport, RevisionField>;
/** The fields a revision tracks, for comparing two versions of a report. */
export function specOf(report: Partial<Spec>): string {
  return JSON.stringify(REVISION_FIELDS.map(field => report[field] ?? null));
}

export function latestRevision(history: ReportHistory): Revision | undefined {
  return history.revisions.at(-1);
}

/** The report fields a revision holds. */
export function revisionSpec(history: ReportHistory, revision: Revision): Partial<Spec> {
  const spec: Record<string, unknown> = {};
  for (const field of REVISION_FIELDS) {
    const key = revision.fields[field];
    if (key === undefined) continue;
    const blob = history.blobs[key];
    if (blob === undefined) throw new Error(`Revision ${revision.id} is missing its ${REVISION_FIELD_LABELS[field].toLowerCase()}.`);
    spec[field] = JSON.parse(blob);
  }
  return spec as Partial<Spec>;
}

/** The report as it was at a revision, keeping `current`'s identity (id, service, creation). */
export function revisionReport(history: ReportHistory, revision: Revision, current: EvidenceReport): EvidenceReport {
  const spec = revisionSpec(history, revision);
  const report = { ...current } as Record<string, unknown>;
  for (const field of REVISION_FIELDS) {
    if (field in spec) report[field] = spec[field as RevisionField];
    else delete report[field];
  }
  return report as EvidenceReport;
}

export interface RevisionMeta {
  kind: RevisionKind;
  label?: string;
  agentSummaries?: string[];
  alsoEdited?: boolean;
  savedAt?: number;
  /** An autosave's editing session. The session's latest revision grows to take the save rather
   *  than a new revision following it, for up to `SESSION_WINDOW_MS`. */
  session?: string;
}
/** How long one editing session's autosaves keep extending the same revision. */
export const SESSION_WINDOW_MS = 10 * 60_000;

/** A label from the fields that changed, for saves nobody described. */
export function describeChanges(changed: RevisionField[], kind: RevisionKind = 'edit'): string {
  if (kind === 'baseline') return 'Saved before revision history began';
  if (!changed.length) return 'No changes';
  const names = changed.map(field => REVISION_FIELD_LABELS[field]);
  return `Changed ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
}

/** Add the report as a new revision, unless it is what the latest revision already holds. */
export function recordRevision(history: ReportHistory, report: EvidenceReport, meta: RevisionMeta, newId: () => string = () => crypto.randomUUID()): ReportHistory {
  const tip = latestRevision(history);
  const savedAt = meta.savedAt ?? Date.now();
  if (meta.session && meta.kind === 'edit' && tip?.kind === 'edit' && tip.session === meta.session && savedAt - (tip.startedAt ?? tip.savedAt) < SESSION_WINDOW_MS) {
    // The session's revision takes this save too: replace it, measured against what came before it.
    const rest: ReportHistory = { revisions: history.revisions.slice(0, -1), blobs: history.blobs };
    const before = latestRevision(rest);
    if (before && specOf(revisionSpec(rest, before)) === specOf(report)) return rest;
    const grown = recordRevision(rest, report, { ...meta, session: undefined, savedAt }, () => tip.id);
    const revision = grown.revisions.at(-1)!;
    // A first version stays the first version, however it grew.
    const label = !before ? tip.label : revision.label;
    return { ...grown, revisions: [...grown.revisions.slice(0, -1), { ...revision, label, session: meta.session, startedAt: tip.startedAt ?? tip.savedAt }] };
  }
  const previous = tip;
  const previousSpec = previous ? revisionSpec(history, previous) : {};
  if (previous && specOf(previousSpec) === specOf(report)) return history;
  const blobs = { ...history.blobs };
  const fields: Revision['fields'] = {};
  for (const field of REVISION_FIELDS) {
    if (report[field] === undefined) continue;
    const text = JSON.stringify(report[field]);
    const key = hash(text);
    blobs[key] = text;
    fields[field] = key;
  }
  // The first version changes nothing: there is nothing before it to differ from.
  const changed = previous ? REVISION_FIELDS.filter(field => JSON.stringify(previousSpec[field] ?? null) !== JSON.stringify(report[field] ?? null)) : [];
  const label = meta.label?.trim() || (meta.kind === 'agent' && meta.agentSummaries?.length ? meta.agentSummaries.join('; ')
    : previous || meta.kind === 'baseline' ? describeChanges(changed, meta.kind) : 'First saved version');
  const revision: Revision = {
    id: newId(), savedAt, kind: meta.kind, label, changed, fields,
    ...(meta.session ? { session: meta.session } : {}),
    ...(meta.agentSummaries?.length ? { agentSummaries: meta.agentSummaries } : {}),
    ...(meta.alsoEdited ? { alsoEdited: true } : {}),
  };
  return { revisions: [...history.revisions, revision], blobs };
}

/** Both histories' revisions (each once, by id) in the order they were saved. */
export function mergeHistories(a: ReportHistory, b: ReportHistory): ReportHistory {
  const byId = new Map<string, Revision>();
  for (const revision of [...a.revisions, ...b.revisions]) if (!byId.has(revision.id)) byId.set(revision.id, revision);
  const revisions = [...byId.values()].sort((x, y) => x.savedAt - y.savedAt || x.id.localeCompare(y.id));
  return { revisions, blobs: { ...a.blobs, ...b.blobs } };
}

/** The history without one revision, and without the blobs only it used. The latest revision is
 *  the saved report, so it can't be removed. The revision after the removed one is now measured
 *  against the one before it: its `changed` fields are recomputed, and a label that only named
 *  them is rewritten to match. */
export function removeRevision(history: ReportHistory, id: string): ReportHistory {
  const index = history.revisions.findIndex(revision => revision.id === id);
  if (index < 0) return history;
  if (index === history.revisions.length - 1) throw new Error('The latest version is the saved report and cannot be removed.');
  const revisions = history.revisions.filter(revision => revision.id !== id);
  const next = revisions[index];
  const previous = revisions[index - 1];
  const nextSpec = revisionSpec(history, next);
  const previousSpec = previous ? revisionSpec(history, previous) : null;
  const changed = previousSpec ? REVISION_FIELDS.filter(field => JSON.stringify(previousSpec[field] ?? null) !== JSON.stringify(nextSpec[field] ?? null)) : [];
  const generated = next.label === describeChanges(next.changed, next.kind);
  const label = !generated ? next.label : previousSpec || next.kind === 'baseline' ? describeChanges(changed, next.kind) : 'First saved version';
  revisions[index] = { ...next, changed, label };
  return compactHistory({ revisions, blobs: history.blobs });
}

/** Drop blobs no revision refers to (after a merge replaced nothing, this is a no-op). */
export function compactHistory(history: ReportHistory): ReportHistory {
  const used = new Set(history.revisions.flatMap(revision => Object.values(revision.fields)));
  return { revisions: history.revisions, blobs: Object.fromEntries(Object.entries(history.blobs).filter(([key]) => used.has(key))) };
}

export function validateHistory(input: unknown): ReportHistory {
  const history = historySchema.parse(input);
  for (const revision of history.revisions) revisionSpec(history, revision);
  return history;
}

// Storage: one key per report, beside the report's own key (different prefix, so report listing
// never reads a history as a report).
export const HISTORY_STORAGE_PREFIX = 'cupola.evidence.history.v1:';
export function historyStorageKey(serviceUrl: string, id: string) {
  return `${HISTORY_STORAGE_PREFIX}${encodeURIComponent(serviceUrl)}:${encodeURIComponent(id)}`;
}
export function loadReportHistory(serviceUrl: string, id: string, storage: Storage = localStorage): ReportHistory {
  const text = storage.getItem(historyStorageKey(serviceUrl, id));
  if (!text) return emptyHistory();
  return validateHistory(JSON.parse(text));
}
/** Saves the history; when storage is full, drops its oldest revisions until it fits (always
 *  keeping the latest), and returns how many were dropped. */
export function saveReportHistory(serviceUrl: string, id: string, history: ReportHistory, storage: Storage = localStorage): number {
  let kept = compactHistory(history);
  for (;;) {
    try { storage.setItem(historyStorageKey(serviceUrl, id), JSON.stringify(kept)); return history.revisions.length - kept.revisions.length; }
    catch (e) {
      if (!isQuotaError(e) || kept.revisions.length <= 1) throw e;
      kept = trimHistory(kept, Math.ceil(kept.revisions.length / 2));
    }
  }
}
/** The history with only its newest `keep` revisions, and the blobs they use. */
export function trimHistory(history: ReportHistory, keep: number): ReportHistory {
  return compactHistory({ revisions: history.revisions.slice(-Math.max(1, keep)), blobs: history.blobs });
}
/** Frees space by halving a report's stored history (oldest first). False when there was nothing to drop. */
export function shrinkStoredHistory(serviceUrl: string, id: string, storage: Storage = localStorage): boolean {
  let history: ReportHistory;
  try { history = loadReportHistory(serviceUrl, id, storage); } catch { return false; }
  if (history.revisions.length <= 1) return false;
  storage.setItem(historyStorageKey(serviceUrl, id), JSON.stringify(trimHistory(history, Math.floor(history.revisions.length / 2))));
  return true;
}
/** localStorage is full (each browser allows a few MB per origin). */
export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22);
}
export function deleteReportHistory(serviceUrl: string, id: string, storage: Storage = localStorage) {
  storage.removeItem(historyStorageKey(serviceUrl, id));
}

export { lineDiff, type DiffLine } from '../line-diff';

/** A field's value as text to diff: strings as they are, everything else as indented JSON. */
export function fieldText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
