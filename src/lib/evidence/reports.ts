import { z } from 'zod';
import { sourceQueries } from './source-queries';
import { semanticDatasetSchema } from './semantic-datasets';
import { appearanceSchema } from './appearance';
import type { ReportParameter, ReportParameterValue } from '../reports/types';

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const parameterSchema = z.object({
  id: z.string(), key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  label: z.string().trim().min(1), type: z.enum(['text', 'number', 'date', 'boolean']),
  required: z.boolean(), defaultValue: scalar,
});
const reportSchema = z.object({
  version: z.literal(1), id: z.string().min(1), title: z.string().trim().min(1),
  source: z.string(), setupSql: z.string(), serviceUrl: z.string(),
  appearance: appearanceSchema.optional(),
  semanticDatasets: z.array(semanticDatasetSchema).optional(),
  pivots: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), datasetId: z.string().min(1), config: z.record(z.string(), z.any()).optional() })).optional(),
  parameters: z.array(parameterSchema), values: z.record(z.string(), scalar),
  createdAt: z.number(), updatedAt: z.number(),
});
export type EvidenceReport = z.infer<typeof reportSchema>;
export type EvidenceParameter = EvidenceReport['parameters'][number];
export type ParameterValues = EvidenceReport['values'];
export const LEGACY_STORAGE_PREFIX = 'cupola.evidence.report.v1:';
export const STORAGE_PREFIX = 'cupola.evidence.report.v2:';
export function evidenceReportStorageKey(serviceUrl: string, id: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(serviceUrl)}:${encodeURIComponent(id)}`;
}

function validateValue(parameter: EvidenceParameter, value: ReportParameterValue, required: boolean) {
  const empty = value === null || value === '';
  if (empty) {
    if (required && parameter.required) throw new Error(`${parameter.label} is required.`);
    return;
  }
  if (parameter.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${parameter.label} must be a number.`);
  if (parameter.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${parameter.label} must be true or false.`);
  if ((parameter.type === 'text' || parameter.type === 'date') && typeof value !== 'string') throw new Error(`${parameter.label} must be text.`);
  if (parameter.type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`${parameter.label} must be a valid date.`);
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
  }
  return report;
}
export function resolveParameters(report: EvidenceReport): ParameterValues {
  validateEvidenceReport(report);
  const values: ParameterValues = {};
  for (const parameter of report.parameters) {
    const value = Object.hasOwn(report.values, parameter.key) ? report.values[parameter.key] : parameter.defaultValue;
    validateValue(parameter, value, true);
    values[parameter.key] = value;
  }
  return values;
}
export function compilerParameters(report: EvidenceReport, values: ParameterValues): { parameters: ReportParameter[] } {
  return { parameters: report.parameters.map(parameter => ({ ...parameter, defaultValue: values[parameter.key] })) };
}
// Keep existing v1 reports readable; saving upgrades only that report after the
// new write succeeds. Each worker has its own namespace, including report IDs.
export function listEvidenceReports(serviceUrl: string, storage: Storage = localStorage): EvidenceReport[] {
  const reports = new Map<string, EvidenceReport>();
  const prefix = evidenceReportStorageKey(serviceUrl, '');
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(LEGACY_STORAGE_PREFIX)) continue;
    const input = JSON.parse(storage.getItem(key)!);
    if (input.serviceUrl === serviceUrl) {
      const report = validateEvidenceReport(input);
      reports.set(report.id, report);
    }
  }
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const report = validateEvidenceReport(JSON.parse(storage.getItem(key)!));
    if (report.serviceUrl !== serviceUrl) throw new Error('Saved report worker URL does not match its storage key.');
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
  storage.setItem(evidenceReportStorageKey(report.serviceUrl, report.id), JSON.stringify(report));
  if (legacy) storage.removeItem(legacy);
  return report;
}
export function deleteEvidenceReport(serviceUrl: string, id: string, storage: Storage = localStorage) {
  const legacy = matchingLegacyKey(serviceUrl, id, storage);
  storage.removeItem(evidenceReportStorageKey(serviceUrl, id));
  if (legacy) storage.removeItem(legacy);
}
