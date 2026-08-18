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
  /** Brief interpretive note shown beneath the block. */
  caption?: string;
  /** Human-readable provenance, such as a table or agency name. */
  source?: string;
  layout: ReportLayout;
}

export interface ReportMapStyle {
  color?: string;
  fillColor?: string;
  opacity?: number;
  fillOpacity?: number;
  weight?: number;
  radius?: number;
}

export interface ReportMapBlock extends ReportBlockBase {
  type: "map";
  datasetId: string;
  /** WKB or GeoJSON geometry column. Takes precedence over coordinate columns. */
  geometryColumn?: string;
  latitudeColumn?: string;
  longitudeColumn?: string;
  labelColumn?: string;
  colorColumn?: string;
  tooltipColumns?: string[];
  basemap?: "none" | "openstreetmap";
  palette?: string[];
  style?: ReportMapStyle;
}

export interface ReportSparklineBlock extends ReportBlockBase {
  type: "sparkline";
  datasetId: string;
  /** Numeric series, plotted in query result order. */
  valueColumn: string;
  /** Optional label from the final plotted row, such as a date or status. */
  labelColumn?: string;
  format?: "number" | "currency" | "percent" | "text";
  showValue?: boolean;
  color?: string;
}

export interface ReportSmallMultiplesBlock extends ReportBlockBase {
  type: "small_multiples";
  datasetId: string;
  facetColumn: string;
  xColumn: string;
  yColumn: string;
  xType?: "temporal" | "quantitative" | "ordinal" | "nominal";
  mark?: "line" | "area" | "bar" | "point";
  colorColumn?: string;
  facetColumns?: number;
  sharedY?: boolean;
  referenceValue?: number;
  referenceLabel?: string;
}

export interface ReportBulletBlock extends ReportBlockBase {
  type: "bullet";
  datasetId: string;
  categoryColumn: string;
  valueColumn: string;
  targetColumn: string;
  /** Broad-to-narrow qualitative range upper bounds, up to three columns. */
  rangeColumns?: string[];
  format?: "number" | "currency" | "percent" | "text";
  color?: string;
}

export interface ReportSlopegraphBlock extends ReportBlockBase {
  type: "slopegraph";
  datasetId: string;
  categoryColumn: string;
  startColumn: string;
  endColumn: string;
  startLabel?: string;
  endLabel?: string;
  colorColumn?: string;
  format?: "number" | "currency" | "percent" | "text";
}

export interface ReportRangeDotBlock extends ReportBlockBase {
  type: "range_dot";
  datasetId: string;
  categoryColumn: string;
  lowColumn: string;
  highColumn: string;
  valueColumn?: string;
  format?: "number" | "currency" | "percent" | "text";
  color?: string;
}

export type ReportBlock =
  | (ReportBlockBase & { type: "markdown"; markdown: string })
  | (ReportBlockBase & { type: "kpi"; datasetId: string; valueColumn: string; labelColumn?: string; format?: "number" | "currency" | "percent" | "text" })
  | ReportSparklineBlock
  | ReportSmallMultiplesBlock
  | ReportBulletBlock
  | ReportSlopegraphBlock
  | ReportRangeDotBlock
  | (ReportBlockBase & { type: "table"; datasetId: string; columns?: string[]; pageSize?: number })
  | (ReportBlockBase & { type: "chart"; datasetId: string; spec: Record<string, any> })
  | (ReportBlockBase & { type: "perspective"; datasetId: string; config?: Record<string, any> })
  | ReportMapBlock;

export interface ReportSourceRequirement {
  catalog: string;
  serviceHint?: string;
}

export interface ReportDocumentV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  /** Persisted report refresh cadence. Omit to disable automatic refresh. */
  refreshIntervalSeconds?: number;
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
