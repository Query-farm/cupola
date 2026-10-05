import { z } from 'zod';
import { sourceQueries } from './source-queries';
import { semanticDatasetSchema } from './semantic-datasets';
import { appearanceSchema } from './appearance';
import type { ReportParameter } from '../reports/types';
import { parameterGraphErrors } from './parameter-graph';
import { initialValue, toReportParameters } from './parameters';
import { historyStorageKey, isQuotaError } from './revisions';
import { legacyScopeFor } from '../workspace/legacy-scope';
// Re-exported for callers that already import from here; modules reports.ts depends on import it from ./parameters.
export { toReportParameters };

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const optionValue = z.union([z.string(), z.number().finite()]);
/** A parameter's value: a scalar, a multi-select list, or a date range. */
const parameterValue = z.union([scalar, z.array(optionValue), z.object({ start: z.string().nullable(), end: z.string().nullable() })]);
export const PARAMETER_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multi_select', 'date_range'] as const;
const parameterSchema = z.object({
  id: z.string(), key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  label: z.string().trim().min(1), type: z.enum(PARAMETER_TYPES),
  description: z.string().optional(),
  required: z.boolean(), defaultValue: parameterValue,
  /** Choices for select / multi_select: listed, or the rows of a query that may use other parameters. */
  options: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('static'), values: z.array(z.object({ label: z.string(), value: optionValue })) }),
    z.object({ kind: z.literal('query'), sql: z.string(), valueColumn: z.string().optional(), labelColumn: z.string().optional() }),
  ]).optional(),
  /** What an unset or no-longer-valid choice becomes: the default value, the first choice, All, or nothing. */
  defaultMode: z.enum(['value', 'first', 'all', 'none']).optional(),
  /** Offer "All" (binds NULL / an empty list; `$key_all` is TRUE). */
  allowAll: z.boolean().optional(),
  /** Column an Evidence `filters=["key"]` predicate compares with; defaults to the key. */
  filterColumn: z.string().optional(),
});
/** An ordered chain of parameters a reader drills through by clicking charts and tables. */
const drillPathSchema = z.object({ id: z.string().min(1), label: z.string().optional(), levels: z.array(z.string()).min(1) });
const reportSchema = z.object({
  version: z.literal(1), id: z.string().min(1), title: z.string().trim().min(1),
  source: z.string(), setupSql: z.string(), serviceUrl: z.string(),
  /** The workspace the report belongs to (multi-catalog phase 2). Reports saved before workspaces
   *  have none and are scoped by `serviceUrl`, the default catalog's URL at the time. */
  workspaceId: z.string().optional(),
  appearance: appearanceSchema.optional(),
  semanticDatasets: z.array(semanticDatasetSchema).optional(),
  pivots: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), datasetId: z.string().min(1), config: z.record(z.string(), z.any()).optional() })).optional(),
  parameters: z.array(parameterSchema), values: z.record(z.string(), parameterValue),
  drillPaths: z.array(drillPathSchema).optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
export type EvidenceReport = z.infer<typeof reportSchema>;
export type EvidenceParameter = EvidenceReport['parameters'][number];
export type ParameterValues = EvidenceReport['values'];
export type ParameterValue = ParameterValues[string];
export type EvidenceDrillPath = NonNullable<EvidenceReport['drillPaths']>[number];
export const EVIDENCE_REPORTS_CHANGED = 'cupola:evidence-reports-changed';
export const LEGACY_STORAGE_PREFIX = 'cupola.evidence.report.v1:';
export const STORAGE_PREFIX = 'cupola.evidence.report.v2:';
/** Reports are stored per scope: the workspace id, or for a report saved before workspaces, the
 *  service URL it was saved against. Every storage function takes the scope where it used to take
 *  the service URL; a workspace scope also reads its legacy URL's keys (`legacy-scope.ts`). */
export function evidenceReportStorageKey(scope: string, id: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(id)}`;
}
/** Where a report is stored. */
export function reportScope(report: Pick<EvidenceReport, 'workspaceId' | 'serviceUrl'>): string {
  return report.workspaceId || report.serviceUrl;
}

function validateValue(parameter: EvidenceParameter, value: ParameterValue, required: boolean) {
  const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0)
    || (parameter.type === 'date_range' && typeof value === 'object' && value !== null && !Array.isArray(value) && !value.start && !value.end);
  if (empty) {
    const allChosen = parameter.allowAll && (parameter.type === 'select' || parameter.type === 'multi_select');
    if (required && parameter.required && !allChosen) throw new Error(`${parameter.label} is required.`);
    return;
  }
  const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  switch (parameter.type) {
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${parameter.label} must be a number.`); break;
    case 'boolean': if (typeof value !== 'boolean') throw new Error(`${parameter.label} must be true or false.`); break;
    case 'text': if (typeof value !== 'string') throw new Error(`${parameter.label} must be text.`); break;
    case 'date': if (!isDate(value)) throw new Error(`${parameter.label} must be a valid date.`); break;
    case 'select': if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${parameter.label} must be one choice.`); break;
    case 'multi_select': if (!Array.isArray(value)) throw new Error(`${parameter.label} must be a list of choices.`); break;
    case 'date_range': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${parameter.label} must be a date range.`);
      for (const part of [value.start, value.end]) if (part !== null && part !== '' && !isDate(part)) throw new Error(`${parameter.label} must use valid dates.`);
      if (value.start && value.end && value.start > value.end) throw new Error(`${parameter.label} must start on or before its end.`);
      if (required && parameter.required && (!value.start || !value.end)) throw new Error(`${parameter.label} needs a start and an end.`);
    }
  }
}
export function validateEvidenceReport(input: unknown): EvidenceReport {
  const report = reportSchema.parse(input);
  const datasetNames = new Set<string>();
  const datasetIds = new Set<string>();
  for (const dataset of report.semanticDatasets ?? []) {
    if (datasetNames.has(dataset.name) || datasetIds.has(dataset.id)) throw new Error('Semantic dataset names and IDs must be unique.');
    datasetNames.add(dataset.name); datasetIds.add(dataset.id);
  }
  for (const query of sourceQueries(report.source)) {
    if (datasetNames.has(query.name)) throw new Error(`Report query "${query.name}" conflicts with a semantic dataset. Use a different name.`);
  }
  const keys = new Set<string>();
  for (const parameter of report.parameters) {
    if (keys.has(parameter.key)) throw new Error(`Duplicate parameter name: ${parameter.key}`);
    keys.add(parameter.key);
    validateValue(parameter, parameter.defaultValue, false);
    if (Object.hasOwn(report.values, parameter.key)) validateValue(parameter, report.values[parameter.key], false);
    if (parameter.options && parameter.type !== 'select' && parameter.type !== 'multi_select') throw new Error(`${parameter.label}: only select and multi-select parameters have choices.`);
  }
  const graphErrors = parameterGraphErrors(report);
  if (graphErrors.length) throw new Error(graphErrors[0]);
  for (const path of report.drillPaths ?? []) {
    for (const level of path.levels) if (!keys.has(level)) throw new Error(`Drill path ${path.label || path.id}: "${level}" is not a parameter.`);
    if (new Set(path.levels).size !== path.levels.length) throw new Error(`Drill path ${path.label || path.id} repeats a level.`);
  }
  return report;
}
export function resolveParameters(report: EvidenceReport): ParameterValues {
  validateEvidenceReport(report);
  const values: ParameterValues = {};
  for (const parameter of report.parameters) {
    const value = Object.hasOwn(report.values, parameter.key) ? report.values[parameter.key] : initialValue(parameter);
    validateValue(parameter, value, true);
    values[parameter.key] = value;
  }
  return values;
}
export function compilerParameters(report: Pick<EvidenceReport, 'parameters'>, values: ParameterValues): { parameters: ReportParameter[] } {
  return { parameters: toReportParameters(report.parameters, values) };
}
// Keep existing v1 reports readable; saving upgrades only that report after the
// new write succeeds. Each worker has its own namespace, including report IDs.
export function listEvidenceReports(scope: string, storage: Storage = localStorage): EvidenceReport[] {
  const reports = new Map<string, EvidenceReport>();
  // A workspace reads the reports saved against its service URL before workspaces, read-only:
  // each records the workspace once it is saved again (under the workspace's own key).
  const legacy = legacyScopeFor(scope);
  const urlScope = legacy ?? scope;
  const adopt = (report: EvidenceReport) => legacy ? { ...report, workspaceId: scope } : report;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(LEGACY_STORAGE_PREFIX)) continue;
    const input = JSON.parse(storage.getItem(key)!);
    if (input.serviceUrl === urlScope && !input.workspaceId) {
      const report = validateEvidenceReport(input);
      reports.set(report.id, adopt(report));
    }
  }
  if (legacy) {
    const prefix = evidenceReportStorageKey(legacy, '');
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const report = validateEvidenceReport(JSON.parse(storage.getItem(key)!));
      if (reportScope(report) !== legacy) continue;
      reports.set(report.id, adopt(report));
    }
  }
  const prefix = evidenceReportStorageKey(scope, '');
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const report = validateEvidenceReport(JSON.parse(storage.getItem(key)!));
    if (reportScope(report) !== scope) throw new Error('Saved report workspace does not match its storage key.');
    reports.set(report.id, report);
  }
  return [...reports.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
function matchingLegacyKey(serviceUrl: string, id: string, storage: Storage): string | undefined {
  const key = LEGACY_STORAGE_PREFIX + id;
  try {
    const value = storage.getItem(key);
    if (value && JSON.parse(value).serviceUrl === serviceUrl) return key;
  } catch { /* Preserve unrecognized legacy data. */ }
}
export function saveEvidenceReport(input: EvidenceReport, storage: Storage = localStorage): EvidenceReport {
  const report = validateEvidenceReport({ ...input, updatedAt: Date.now() });
  const legacy = matchingLegacyKey(report.serviceUrl, report.id, storage);
  storage.setItem(evidenceReportStorageKey(reportScope(report), report.id), JSON.stringify(report));
  if (legacy) storage.removeItem(legacy);
  if (typeof window !== 'undefined' && storage === window.localStorage) window.dispatchEvent(new Event(EVIDENCE_REPORTS_CHANGED));
  return report;
}
export function deleteEvidenceReport(scope: string, id: string, storage: Storage = localStorage) {
  // Deleting is the reader's choice, so the pre-workspace copy goes too; otherwise the fallback
  // would bring the report back.
  const url = legacyScopeFor(scope);
  for (const s of url ? [scope, url] : [scope]) {
    const legacy = matchingLegacyKey(s, id, storage);
    storage.removeItem(evidenceReportStorageKey(s, id));
    storage.removeItem(historyStorageKey(s, id));
    storage.removeItem(recoveryDraftKey(s, id));
    if (legacy) storage.removeItem(legacy);
  }
  if (typeof window !== 'undefined' && storage === window.localStorage) window.dispatchEvent(new Event(EVIDENCE_REPORTS_CHANGED));
}

/** One line for a report that fails validation: the first problem, not zod's JSON dump. */
export function describeReportError(error: unknown): string {
  if (isQuotaError(error)) return STORAGE_FULL_MESSAGE;
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray((error as { issues: unknown[] }).issues)) {
    const issue = (error as { issues: { path: PropertyKey[]; message: string }[] }).issues[0];
    return issue ? `${issue.path.map(String).join('.') || 'report'}: ${issue.message}` : 'invalid report';
  }
  return error instanceof Error ? error.message : String(error);
}

/** A draft autosave could not save (it doesn't validate: a blank title, a parameter mid-edit),
 *  kept as it is so a closed tab doesn't lose it. The next successful save removes it; opening
 *  the report brings it back. */
export const RECOVERY_DRAFT_PREFIX = 'cupola.evidence.draft.v1:';
export function recoveryDraftKey(scope: string, id: string) {
  return `${RECOVERY_DRAFT_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(id)}`;
}
/** False when it could not be kept either (storage full): the draft is then only in the tab. */
export function saveRecoveryDraft(report: EvidenceReport, storage: Storage = localStorage): boolean {
  try { storage.setItem(recoveryDraftKey(reportScope(report), report.id), JSON.stringify({ savedAt: Date.now(), report })); return true; }
  catch { return false; }
}
export function clearRecoveryDraft(scope: string, id: string, storage: Storage = localStorage) {
  storage.removeItem(recoveryDraftKey(scope, id));
}
function readDraft(keyScope: string, scope: string, id: string, storage: Storage, adopt: boolean): EvidenceReport | null {
  try {
    const text = storage.getItem(recoveryDraftKey(keyScope, id));
    if (!text) return null;
    const draft = JSON.parse(text).report;
    if (!draft || typeof draft !== 'object' || draft.id !== id || reportScope(draft) !== keyScope) return null;
    return (adopt ? { ...draft, workspaceId: scope } : draft) as EvidenceReport;
  } catch { return null; }
}
/** The unsaved draft for a report, when there is one that differs from what is saved. A workspace
 *  falls back to a draft kept under its pre-workspace service URL. */
export function loadRecoveryDraft(scope: string, id: string, storage: Storage = localStorage): EvidenceReport | null {
  const own = readDraft(scope, scope, id, storage, false);
  if (own) return own;
  const legacy = legacyScopeFor(scope);
  return legacy ? readDraft(legacy, scope, id, storage, true) : null;
}
/** Drafts of reports that were never saved (a new report that didn't validate, or storage was
 *  full): no saved report opens them, so the library lists them. Newest first. */
export function listUnsavedDrafts(scope: string, savedIds: ReadonlySet<string>, storage: Storage = localStorage): { report: EvidenceReport; savedAt: number }[] {
  const drafts = new Map<string, { report: EvidenceReport; savedAt: number }>();
  const legacy = legacyScopeFor(scope);
  for (const keyScope of legacy ? [legacy, scope] : [scope]) {
    const prefix = recoveryDraftKey(keyScope, '');
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const id = decodeURIComponent(key.slice(prefix.length));
      if (savedIds.has(id)) continue;
      const report = readDraft(keyScope, scope, id, storage, keyScope !== scope);
      if (!report) continue;
      let savedAt = 0;
      try { savedAt = Number(JSON.parse(storage.getItem(key)!).savedAt) || 0; } catch { /* Unknown age. */ }
      drafts.set(id, { report, savedAt });
    }
  }
  return [...drafts.values()].sort((a, b) => b.savedAt - a.savedAt);
}

/** A blank title is a title being retyped, not a problem: it saves as "Untitled report". */
export const UNTITLED_REPORT = 'Untitled report';
export function titled<T extends { title: string }>(report: T): T {
  return report.title.trim() ? report : { ...report, title: UNTITLED_REPORT };
}

export { isQuotaError };
export const STORAGE_FULL_MESSAGE = 'this browser’s storage for Cupola is full. Export report files, then delete reports you no longer need';
