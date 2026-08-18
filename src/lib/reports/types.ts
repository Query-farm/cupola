export type ReportParameterType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "date_range"
  | "select"
  | "multi_select";

export type ReportParameterValue = string | number | boolean | null | string[] | { start: string | null; end: string | null };

export interface ReportOption {
  label: string;
  value: string | number;
}

export interface ReportParameter {
  id: string;
  key: string;
  label: string;
  type: ReportParameterType;
  description?: string;
  required?: boolean;
  defaultValue: ReportParameterValue;
  options?:
    | { kind: "static"; values: ReportOption[] }
    | { kind: "dataset"; datasetId: string; valueColumn: string; labelColumn?: string };
}

export interface ReportDataset {
  id: string;
  name: string;
  sql: string;
  description?: string;
  role?: "data" | "parameter_options";
}

export interface ReportLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ReportBlockBase {
  id: string;
  title?: string;
  layout: ReportLayout;
}

export type ReportBlock =
  | (ReportBlockBase & { type: "markdown"; markdown: string })
  | (ReportBlockBase & { type: "kpi"; datasetId: string; valueColumn: string; labelColumn?: string; format?: "number" | "currency" | "percent" | "text" })
  | (ReportBlockBase & { type: "table"; datasetId: string; columns?: string[]; pageSize?: number })
  | (ReportBlockBase & { type: "chart"; datasetId: string; spec: Record<string, any> })
  | (ReportBlockBase & { type: "perspective"; datasetId: string; config?: Record<string, any> });

export interface ReportSourceRequirement {
  catalog: string;
  serviceHint?: string;
}

export interface ReportDocumentV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  requiredSources: ReportSourceRequirement[];
  parameters: ReportParameter[];
  datasets: ReportDataset[];
  blocks: ReportBlock[];
}

export interface StoredReport {
  document: ReportDocumentV1;
  revisions: ReportDocumentV1[];
}

export function newReportId(prefix = "report"): string {
  try { return `${prefix}-${crypto.randomUUID()}`; } catch {}
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createEmptyReport(title = "Untitled report", catalog?: string, serviceHint?: string): ReportDocumentV1 {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: newReportId(),
    title,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: catalog ? [{ catalog, serviceHint }] : [],
    parameters: [],
    datasets: [],
    blocks: [],
  };
}

export function cloneReport(report: ReportDocumentV1): ReportDocumentV1 {
  return structuredClone(report);
}
