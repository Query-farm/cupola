import type { ReportBlock, ReportDocumentV1 } from "./types";

export interface ReportDatasetShape {
  datasetId: string;
  ok: boolean;
  columns?: string[];
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
  else if (block.type === "kpi") columns = [block.valueColumn, block.labelColumn].filter((column): column is string => !!column);
  else if (block.type === "sparkline") columns = [block.valueColumn, block.labelColumn].filter((column): column is string => !!column);
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
