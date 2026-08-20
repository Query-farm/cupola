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
  columns.push(...(block.appearance?.rules ?? []).map((rule) => rule.column));
  return columns.filter((column, index, all) => all.indexOf(column) === index);
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
