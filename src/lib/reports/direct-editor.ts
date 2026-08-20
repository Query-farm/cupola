import { requestedReportBlockLayout } from "./agent-tools";
import { newReportId, type ReportBlock, type ReportDocumentV1 } from "./types";

export const REPORT_BLOCK_TYPES: Array<{ type: ReportBlock["type"]; label: string; group: "Text" | "Metrics" | "Visualizations" | "Data" }> = [
  { type: "markdown", label: "Text", group: "Text" },
  { type: "ai_narrative", label: "AI narrative", group: "Text" },
  { type: "kpi", label: "KPI", group: "Metrics" },
  { type: "sparkline", label: "Sparkline", group: "Metrics" },
  { type: "bullet", label: "Bullet chart", group: "Metrics" },
  { type: "range_dot", label: "Range dot", group: "Metrics" },
  { type: "slopegraph", label: "Slopegraph", group: "Visualizations" },
  { type: "small_multiples", label: "Small multiples", group: "Visualizations" },
  { type: "chart", label: "Chart", group: "Visualizations" },
  { type: "map", label: "Map", group: "Visualizations" },
  { type: "table", label: "Table", group: "Data" },
  { type: "perspective", label: "Perspective", group: "Data" },
];

export type BasicChartMark = "bar" | "line" | "area" | "point" | "tick";
export type BasicChartType = "auto" | "quantitative" | "temporal" | "ordinal" | "nominal";
export type BasicChartAggregate = "none" | "count" | "sum" | "mean" | "median" | "min" | "max";

export interface BasicChartConfig {
  mark: BasicChartMark;
  xField: string;
  xType: BasicChartType;
  xAggregate: BasicChartAggregate;
  xTitle: string;
  yField: string;
  yType: BasicChartType;
  yAggregate: BasicChartAggregate;
  yTitle: string;
  colorField: string;
  fixedColor: string;
  facetRow: string;
  facetColumn: string;
  legend: boolean;
  legendTitle: string;
  zero: "auto" | "include" | "exclude";
  palette: string;
}

const MARKS = new Set<BasicChartMark>(["bar", "line", "area", "point", "tick"]);
const TYPES = new Set<Exclude<BasicChartType, "auto">>(["quantitative", "temporal", "ordinal", "nominal"]);
const AGGREGATES = new Set<Exclude<BasicChartAggregate, "none">>(["count", "sum", "mean", "median", "min", "max"]);

function channel(spec: Record<string, any>, key: string): Record<string, any> {
  const value = spec.encoding?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function basicChartConfigFromSpec(spec: Record<string, any>): BasicChartConfig | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  if (["layer", "concat", "hconcat", "vconcat", "repeat", "transform", "facet"].some((key) => key in spec)) return null;
  const mark = typeof spec.mark === "string" ? spec.mark : spec.mark?.type;
  if (!MARKS.has(mark)) return null;
  const allowed = new Set(["x", "y", "color", "row", "column", "tooltip"]);
  if (Object.keys(spec.encoding ?? {}).some((key) => !allowed.has(key))) return null;
  const x = channel(spec, "x"), y = channel(spec, "y"), color = channel(spec, "color");
  const row = channel(spec, "row"), column = channel(spec, "column");
  const scale = y.scale ?? {};
  const config: BasicChartConfig = {
    mark,
    xField: String(x.field ?? ""),
    xType: TYPES.has(x.type) ? x.type : "auto",
    xAggregate: AGGREGATES.has(x.aggregate) ? x.aggregate : "none",
    xTitle: String(x.title ?? ""),
    yField: String(y.field ?? ""),
    yType: TYPES.has(y.type) ? y.type : "auto",
    yAggregate: AGGREGATES.has(y.aggregate) ? y.aggregate : "none",
    yTitle: String(y.title ?? ""),
    colorField: String(color.field ?? ""),
    fixedColor: typeof spec.mark === "object" ? String(spec.mark.color ?? "") : "",
    facetRow: String(row.field ?? ""),
    facetColumn: String(column.field ?? ""),
    legend: color.legend !== null,
    legendTitle: String(color.legend?.title ?? ""),
    zero: scale.zero === true ? "include" : scale.zero === false ? "exclude" : "auto",
    palette: String(color.scale?.scheme ?? ""),
  };
  // The basic editor rebuilds the Vega-Lite spec from these fields. Only
  // admit specs that survive that round trip exactly; otherwise an innocent
  // axis or color edit could silently discard an agent-authored config,
  // transform, scale domain, mark property, or custom tooltip.
  if (canonicalJson(basicChartSpec(config)) !== canonicalJson(spec)) return null;
  return config;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function basicChartSpec(config: BasicChartConfig): Record<string, any> {
  const fieldChannel = (field: string, type: BasicChartType, aggregate: BasicChartAggregate, title: string) => {
    const value: Record<string, any> = {};
    if (field) value.field = field;
    if (type !== "auto") value.type = type;
    if (aggregate !== "none") value.aggregate = aggregate;
    if (title) value.title = title;
    return value;
  };
  const x = fieldChannel(config.xField, config.xType, config.xAggregate, config.xTitle);
  const y = fieldChannel(config.yField, config.yType, config.yAggregate, config.yTitle);
  const encoding: Record<string, any> = { x, y, tooltip: [x, y].filter((item) => item.field).map((item) => ({ ...item })) };
  if (config.zero !== "auto") encoding.y.scale = { zero: config.zero === "include" };
  if (config.colorField) {
    encoding.color = { field: config.colorField, type: "nominal", legend: config.legend ? (config.legendTitle ? { title: config.legendTitle } : {}) : null };
    if (config.palette) encoding.color.scale = { scheme: config.palette };
    encoding.tooltip.push({ field: config.colorField, type: "nominal", ...(config.legendTitle ? { title: config.legendTitle } : {}) });
  }
  if (config.facetRow) encoding.row = { field: config.facetRow, type: "nominal" };
  if (config.facetColumn) encoding.column = { field: config.facetColumn, type: "nominal" };
  return {
    mark: config.fixedColor ? { type: config.mark, color: config.fixedColor } : config.mark,
    encoding,
  };
}

export function createReportBlock(report: ReportDocumentV1, type: ReportBlock["type"], datasetId: string | undefined, columns: string[]): ReportBlock {
  const layout = requestedReportBlockLayout(report.blocks, type);
  const id = newReportId("block");
  const first = columns[0] ?? "", second = columns[1] ?? first, third = columns[2] ?? second;
  const base = { id, type, layout } as const;
  if (type === "markdown") return { ...base, type, markdown: "Write report text here." };
  const data = datasetId ?? report.datasets[0]?.id ?? "";
  if (type === "kpi") return { ...base, type, datasetId: data, valueColumn: first };
  if (type === "sparkline") return { ...base, type, datasetId: data, valueColumn: first, showValue: true };
  if (type === "table") return { ...base, type, datasetId: data };
  if (type === "chart") return { ...base, type, datasetId: data, spec: basicChartSpec({ mark: "line", xField: first, xType: "auto", xAggregate: "none", xTitle: "", yField: second, yType: "auto", yAggregate: "none", yTitle: "", colorField: "", fixedColor: "", facetRow: "", facetColumn: "", legend: true, legendTitle: "", zero: "auto", palette: "" }) };
  if (type === "perspective") return { ...base, type, datasetId: data };
  if (type === "ai_narrative") return { ...base, type, datasetId: data, instruction: "Summarize the most important findings.", refreshPolicy: "manual" };
  if (type === "small_multiples") return { ...base, type, datasetId: data, facetColumn: first, xColumn: second, yColumn: third, mark: "line", sharedY: true };
  if (type === "bullet") return { ...base, type, datasetId: data, categoryColumn: first, valueColumn: second, targetColumn: third, showValues: "auto" };
  if (type === "slopegraph") return { ...base, type, datasetId: data, categoryColumn: first, startColumn: second, endColumn: third };
  if (type === "range_dot") return { ...base, type, datasetId: data, categoryColumn: first, lowColumn: second, highColumn: third, showValues: "auto" };
  const latitude = columns.find((column) => /^(?:lat|latitude)$/i.test(column));
  const longitude = columns.find((column) => /^(?:lon|lng|longitude)$/i.test(column));
  const geometry = columns.find((column) => /^(?:geom|geometry|wkb|geojson)$/i.test(column));
  return { ...base, type: "map", datasetId: data, ...(geometry ? { geometryColumn: geometry } : { latitudeColumn: latitude ?? first, longitudeColumn: longitude ?? second }), basemap: "openstreetmap" };
}

export function duplicateReportBlock(report: ReportDocumentV1, source: ReportBlock): ReportBlock {
  const copy = structuredClone(source);
  copy.id = newReportId("block");
  copy.title = source.title ? `Copy of ${source.title}` : undefined;
  copy.layout = requestedReportBlockLayout(report.blocks, source.type, undefined, undefined, source.groupId);
  return copy;
}
