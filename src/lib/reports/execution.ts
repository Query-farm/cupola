import type { ReportBlock, ReportDocumentV1 } from "./types";

export interface ReportDatasetShape {
  datasetId: string;
  ok: boolean;
  columns?: string[];
}

function referencedColumns(block: ReportBlock): string[] {
  if (block.type === "table") return block.columns ?? [];
  if (block.type === "kpi") return [block.valueColumn, block.labelColumn].filter((column): column is string => !!column);
  if (block.type === "map") return [
    block.geometryColumn,
    block.latitudeColumn,
    block.longitudeColumn,
    block.labelColumn,
    block.colorColumn,
    ...(block.tooltipColumns ?? []),
  ].filter((column, index, all): column is string => !!column && all.indexOf(column) === index);
  return [];
}

/** Validate block-level column references after datasets have actually run. */
export function validateReportResultColumns(report: ReportDocumentV1, datasets: ReportDatasetShape[]): string[] {
  const shapes = new Map(datasets.map((dataset) => [dataset.datasetId, dataset]));
  const errors: string[] = [];
  for (const block of report.blocks) {
    if (block.type === "markdown" || block.type === "chart" || block.type === "perspective") continue;
    const shape = shapes.get(block.datasetId);
    if (!shape?.ok || !shape.columns) continue;
    const available = new Set(shape.columns);
    const missing = referencedColumns(block).filter((column) => !available.has(column));
    if (missing.length) errors.push(`${block.title ?? block.id}: missing result column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`);
  }
  return errors;
}
