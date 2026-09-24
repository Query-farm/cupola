import type { ReportBlock, ReportDocumentV1 } from "./types";

export interface ReportDatasetShape {
  datasetId: string;
  ok: boolean;
  columns?: string[];
}

export type ReportQueryErrorCode = "rate_limited" | "service_unavailable" | "query_failed" | "blocked";

export interface ClassifiedReportQueryError {
  code: Exclude<ReportQueryErrorCode, "blocked">;
  message: string;
  technicalDetails: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  /** A source-wide failure means later queries in this run would only add load. */
  stopRun: boolean;
}

export interface ReportRunFailureLike {
  name: string;
  error?: string;
  errorDetails?: string;
  errorCode?: ReportQueryErrorCode;
  retryAfterSeconds?: number;
  stale?: boolean;
}

export interface ReportRunFailureNotice {
  title: string;
  message: string;
  details: string[];
  retryAfterSeconds?: number;
}

function compactTechnicalDetails(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  const stackStart = normalized.search(/\s+at\s+(?:async\s+)?[^ ]+\s*\(/i);
  return (stackStart >= 0 ? normalized.slice(0, stackStart) : normalized).slice(0, 1_000);
}

function retryDelaySeconds(raw: string): number {
  if (/\bone minute\b/i.test(raw)) return 60;
  const seconds = /(?:try again|retry)(?:\s+in|\s+after)?\s+(\d+)\s*seconds?/i.exec(raw)?.[1];
  if (seconds) return Math.max(1, Number(seconds));
  const minutes = /(?:try again|retry)(?:\s+in|\s+after)?\s+(\d+)\s*minutes?/i.exec(raw)?.[1];
  return minutes ? Math.max(1, Number(minutes) * 60) : 60;
}

/** Turn transport/provider errors into stable reader-facing states. Raw worker
 * stacks remain available only as compact technical details. */
export function classifyReportQueryError(rawError: unknown): ClassifiedReportQueryError {
  const raw = rawError instanceof Error ? rawError.message : String(rawError || "Query failed");
  const technicalDetails = compactTechnicalDetails(raw);
  const openMeteo = /open[ -]?meteo/i.test(raw);
  if (/\bHTTP\s*429\b|\brate[ -]?limit(?:ed| exceeded)?\b|too many requests|minutely api request limit/i.test(raw)) {
    const retryAfterSeconds = retryDelaySeconds(raw);
    return {
      code: "rate_limited",
      message: `${openMeteo ? "Open-Meteo" : "The data service"} is temporarily limiting requests. Try again in about ${retryAfterSeconds >= 60 ? `${Math.ceil(retryAfterSeconds / 60)} minute${retryAfterSeconds >= 120 ? "s" : ""}` : `${retryAfterSeconds} seconds`}.`,
      technicalDetails: openMeteo
        ? "HTTP 429 from Open-Meteo: the request limit was exceeded."
        : technicalDetails,
      retryable: true,
      retryAfterSeconds,
      stopRun: true,
    };
  }
  if (/\bHTTP\s*5\d\d\b|service unavailable|temporarily unavailable|gateway timeout|connection (?:failed|reset)|network error/i.test(raw)) {
    return {
      code: "service_unavailable",
      message: `${openMeteo ? "Open-Meteo" : "The data service"} is temporarily unavailable. Try refreshing again shortly.`,
      technicalDetails,
      retryable: true,
      stopRun: false,
    };
  }
  return {
    code: "query_failed",
    message: technicalDetails || "The dataset query failed.",
    technicalDetails: technicalDetails || "Query failed.",
    retryable: false,
    stopRun: false,
  };
}

export function buildReportRunFailureNotice(failures: ReportRunFailureLike[], total: number): ReportRunFailureNotice {
  const blocked = failures.filter((failure) => failure.errorCode === "blocked");
  const attemptedFailures = failures.filter((failure) => failure.errorCode !== "blocked");
  const rateLimit = attemptedFailures.find((failure) => failure.errorCode === "rate_limited");
  const stale = failures.some((failure) => failure.stale);
  const details = failures.map((failure) => `${failure.name}: ${failure.errorDetails ?? failure.error ?? "Dataset refresh failed."}`);
  if (rateLimit) {
    const blockedMessage = blocked.length
      ? ` ${blocked.length} remaining dataset${blocked.length === 1 ? " was" : "s were"} not requested.`
      : "";
    return {
      title: "Data refresh paused",
      message: `${rateLimit.error ?? "The data service is temporarily limiting requests."}${blockedMessage}${stale ? " Previously loaded data remains visible where available." : ""}`,
      details,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    };
  }
  return {
    title: "Some data could not refresh",
    message: `${attemptedFailures.length} of ${total} dataset${total === 1 ? "" : "s"} failed. Other independent datasets were refreshed.${stale ? " Previously loaded data remains visible where available." : ""}`,
    details,
  };
}

/** True when Vega-Lite discarded or could not understand part of a spec.
 * Benign advisories (for example, a log domain containing zero) stay
 * non-blocking, but silently dropped encodings must be repaired by the agent. */
export function isBlockingVegaWarning(warning: string): boolean {
  return /\b(?:dropping|dropped|incompatible|invalid|unsupported|cannot|does not contain any data field)\b/i.test(warning);
}

function referencedColumns(block: ReportBlock): string[] {
  let columns: string[] = [];
  if (block.type === "table") columns = block.columns ?? [];
  else if (block.type === "kpi") columns = [block.valueColumn, block.labelColumn, block.lowColumn, block.highColumn, block.targetColumn].filter((column): column is string => !!column);
  else if (block.type === "sparkline") columns = [block.valueColumn, block.labelColumn, block.splitColumn, block.headlineValueColumn].filter((column): column is string => !!column);
  else if (block.type === "small_multiples") columns = [block.facetColumn, block.xColumn, block.yColumn, block.colorColumn].filter((column): column is string => !!column);
  else if (block.type === "bullet") columns = [block.categoryColumn, block.valueColumn, block.targetColumn, ...(block.rangeColumns ?? [])];
  else if (block.type === "slopegraph") columns = [block.categoryColumn, block.startColumn, block.endColumn, block.colorColumn].filter((column): column is string => !!column);
  else if (block.type === "range_dot") columns = [block.categoryColumn, block.lowColumn, block.highColumn, block.valueColumn].filter((column): column is string => !!column);
  else if (block.type === "ai_narrative") columns = block.columns ?? [];
  else if (block.type === "map") columns = [
    block.geometryColumn,
    block.latitudeColumn,
    block.longitudeColumn,
    block.labelColumn,
    block.colorColumn,
    ...(block.tooltipColumns ?? []),
  ].filter((column): column is string => !!column);
  if (block.type === "chart" && block.filter) columns.push(block.filter.column);
  columns.push(...(block.appearance?.rules ?? []).map((rule) => rule.column));
  return columns.filter((column, index, all) => all.indexOf(column) === index);
}

/** Blocks that read the decoded Arrow table directly and never touch the
 *  per-row JS objects, unless an appearance rule makes them. */
const ROW_FREE_BLOCK_TYPES = new Set<ReportBlock["type"]>(["perspective", "table", "map"]);

/** Whether anything in the report consumes this dataset as JS row objects.
 *
 * Row objects are by far the heaviest form a result takes — one object per
 * row, one property per column — and a Perspective, table or map block never
 * reads them. Materializing them unconditionally is part of what killed the
 * tab on a several-hundred-thousand-row Perspective dataset. A dataset no
 * block references yet (the agent runs a dataset before adding its blocks)
 * needs none either; the block's own run re-evaluates this. */
export function reportDatasetNeedsRows(report: ReportDocumentV1, datasetId: string): boolean {
  const dataset = report.datasets.find((candidate) => candidate.id === datasetId);
  if (dataset?.role && dataset.role !== "data") return true;
  for (const parameter of report.parameters) {
    if (parameter.options?.kind === "dataset" && parameter.options.datasetId === datasetId) return true;
    if (parameter.validationDataset?.datasetId === datasetId) return true;
  }
  return report.blocks.some((block) => block.type !== "markdown"
    && block.datasetId === datasetId
    && (!ROW_FREE_BLOCK_TYPES.has(block.type) || Boolean(block.appearance?.rules?.length)));
}

/** Validate block-level column references after datasets have actually run. */
export function validateReportResultColumns(report: ReportDocumentV1, datasets: ReportDatasetShape[]): string[] {
  const shapes = new Map(datasets.map((dataset) => [dataset.datasetId, dataset]));
  const errors: string[] = [];
  for (const block of report.blocks) {
    if (block.type === "markdown") continue;
    const shape = shapes.get(block.datasetId);
    if (!shape?.ok || !shape.columns) continue;
    const available = new Set(shape.columns);
    const missing = referencedColumns(block).filter((column) => !available.has(column));
    if (missing.length) errors.push(`${block.title ?? block.id}: missing result column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`);
  }
  return errors;
}

/**
 * Canvas width the table check assumes: a laptop screen beside the catalog
 * sidebar. The check is advisory — a wider screen fits more — so it is sized
 * for the common reader rather than the author's monitor.
 */
const TABLE_REFERENCE_CANVAS_PX = 1100;
// Report grid geometry (ReportsWorkspace): 12 columns, 12px gutters and
// container padding, and 26px of block padding and borders around the table.
const GRID_COLUMNS = 12;
const GRID_GUTTER_PX = 12;
const BLOCK_CHROME_PX = 26;
// QueryResultTable: 12px monospace (≈7.2px a character), 8px of padding
// either side of every cell, and body cells truncated at 200px.
const TABLE_CHAR_PX = 7.2;
const TABLE_CELL_PADDING_PX = 16;
const TABLE_BODY_CELL_MAX_PX = 200;

function tableBlockWidthPx(gridColumns: number): number {
  const columnPx = (TABLE_REFERENCE_CANVAS_PX - GRID_GUTTER_PX * 2 - GRID_GUTTER_PX * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
  return gridColumns * columnPx + (gridColumns - 1) * GRID_GUTTER_PX - BLOCK_CHROME_PX;
}

function sampleText(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "object" && !(value instanceof Date)) {
    try {
      return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "";
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Warn when a table block's columns are unlikely to fit its width, since the
 * reader would have to scroll sideways. Estimated from each column's header
 * and a few sample rows; advisory, never an error.
 */
export function reportTableWidthWarnings(
  report: ReportDocumentV1,
  datasets: Array<ReportDatasetShape & { sample?: Record<string, unknown>[] }>,
): string[] {
  const shapes = new Map(datasets.map((dataset) => [dataset.datasetId, dataset]));
  const warnings: string[] = [];
  for (const block of report.blocks) {
    if (block.type !== "table") continue;
    const shape = shapes.get(block.datasetId);
    if (!shape?.ok || !shape.columns) continue;
    const columns = block.columns ?? shape.columns;
    const sample = shape.sample ?? [];
    const needed = columns.reduce((sum, column) => {
      const header = column.length * TABLE_CHAR_PX;
      const body = Math.min(TABLE_BODY_CELL_MAX_PX - TABLE_CELL_PADDING_PX, Math.max(0, ...sample.map((row) => sampleText(row[column]).length * TABLE_CHAR_PX)));
      return sum + Math.max(header, body) + TABLE_CELL_PADDING_PX;
    }, 0);
    const available = tableBlockWidthPx(block.layout.w);
    if (needed <= available) continue;
    warnings.push(`${block.title ?? block.id}: its ${columns.length} columns need about ${Math.round(needed)}px, but a ${block.layout.w}/12-width block shows about ${Math.round(available)}px on a typical laptop, so readers would have to scroll sideways. List only the essential fields in columns, shorten long values in SQL, give the table full width, or split it into separate tables.`);
  }
  return warnings;
}
