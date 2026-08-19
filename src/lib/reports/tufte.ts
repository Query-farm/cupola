import type {
  ReportBlock,
  ReportBulletBlock,
  ReportRangeDotBlock,
  ReportSlopegraphBlock,
  ReportSmallMultiplesBlock,
} from "./types";

export type ReportTufteBlock =
  | ReportSmallMultiplesBlock
  | ReportBulletBlock
  | ReportSlopegraphBlock
  | ReportRangeDotBlock;

const BLUE = "#2563eb";
const INK = "#334155";
const MUTED = "#94a3b8";

const cleanConfig = {
  view: { stroke: null },
  axis: {
    domain: false,
    ticks: false,
    gridColor: "#cbd5e1",
    gridOpacity: 0.35,
    labelColor: "#475569",
    title: null,
  },
  legend: { title: null, orient: "bottom" },
};

function quantitativeFormat(format?: "number" | "currency" | "percent" | "text"): string | undefined {
  if (format === "currency") return "$,.2f";
  if (format === "percent") return ".1%";
  if (format === "number") return ",.2~f";
  return undefined;
}

function tooltip(field: string, type: "nominal" | "quantitative" | "temporal" | "ordinal", format?: string): Record<string, unknown> {
  return { field, type, ...(format ? { format } : {}) };
}

function smallMultiplesSpec(block: ReportSmallMultiplesBlock): Record<string, any> {
  const mainMark = block.mark ?? "line";
  const mainLayer = {
    mark: mainMark === "line"
      ? { type: "line", strokeWidth: 1.5, point: { filled: true, size: 22 } }
      : mainMark === "area"
        ? { type: "area", opacity: 0.45, line: true }
        : { type: mainMark, ...(mainMark === "point" ? { filled: true, size: 42 } : {}) },
    encoding: {
      x: { field: block.xColumn, type: block.xType ?? "temporal", axis: { title: null, grid: false, labelAngle: 0 } },
      y: { field: block.yColumn, type: "quantitative", axis: { title: null }, scale: { zero: false } },
      ...(block.colorColumn
        ? { color: { field: block.colorColumn, type: "nominal" } }
        : { color: { value: BLUE } }),
      tooltip: [
        tooltip(block.facetColumn, "nominal"),
        tooltip(block.xColumn, block.xType ?? "temporal"),
        tooltip(block.yColumn, "quantitative"),
        ...(block.colorColumn ? [tooltip(block.colorColumn, "nominal")] : []),
      ],
    },
  };
  const layers: Record<string, any>[] = [mainLayer];
  if (block.referenceValue !== undefined) {
    layers.push({
      mark: { type: "rule", color: MUTED, strokeDash: [4, 3] },
      encoding: { y: { datum: block.referenceValue, type: "quantitative", scale: { zero: false } } },
    });
    if (block.referenceLabel) layers.push({
      mark: { type: "text", align: "left", dx: 4, dy: -5, color: INK, fontSize: 9 },
      encoding: {
        x: { value: 0 },
        y: { datum: block.referenceValue, type: "quantitative", scale: { zero: false } },
        text: { value: block.referenceLabel },
      },
    });
  }
  return {
    facet: {
      field: block.facetColumn,
      type: "nominal",
      columns: block.facetColumns ?? 3,
      header: { title: null, labelFontSize: 11, labelFontWeight: "bold", labelColor: INK },
    },
    spec: { width: 180, height: 120, layer: layers },
    resolve: { scale: { y: block.sharedY === false ? "independent" : "shared" } },
    config: cleanConfig,
  };
}

function bulletSpec(block: ReportBulletBlock): Record<string, any> {
  const format = quantitativeFormat(block.format);
  const ranges = (block.rangeColumns ?? []).slice(0, 3);
  const rangeColors = ["#e2e8f0", "#cbd5e1", "#94a3b8"];
  return {
    layer: [
      ...ranges.map((field, index) => ({
        mark: { type: "bar", size: 28, color: rangeColors[index] },
        encoding: {
          y: { field: block.categoryColumn, type: "nominal", sort: null, axis: { title: null, grid: false } },
          x: { field, type: "quantitative", axis: { title: null }, ...(format ? { axis: { title: null, format } } : {}) },
        },
      })),
      {
        mark: { type: "bar", size: 11, color: block.color ?? BLUE },
        encoding: {
          y: { field: block.categoryColumn, type: "nominal", sort: null, axis: { title: null, grid: false } },
          x: { field: block.valueColumn, type: "quantitative", axis: { title: null, ...(format ? { format } : {}) } },
          tooltip: [tooltip(block.categoryColumn, "nominal"), tooltip(block.valueColumn, "quantitative", format), tooltip(block.targetColumn, "quantitative", format)],
        },
      },
      {
        mark: { type: "tick", orient: "vertical", size: 24, thickness: 2, color: "#0f172a" },
        encoding: {
          y: { field: block.categoryColumn, type: "nominal", sort: null },
          x: { field: block.targetColumn, type: "quantitative" },
        },
      },
    ],
    config: cleanConfig,
  };
}

function slopegraphSpec(block: ReportSlopegraphBlock): Record<string, any> {
  const startLabel = block.startLabel ?? block.startColumn;
  const endLabel = block.endLabel ?? block.endColumn;
  const format = quantitativeFormat(block.format);
  const periodExpression = `datum.__period === ${JSON.stringify(block.startColumn)} ? ${JSON.stringify(startLabel)} : ${JSON.stringify(endLabel)}`;
  const color = block.colorColumn
    ? { field: block.colorColumn, type: "nominal", legend: null }
    : { field: block.categoryColumn, type: "nominal", legend: null };
  return {
    transform: [
      { fold: [block.startColumn, block.endColumn], as: ["__period", "__value"] },
      { calculate: periodExpression, as: "__period_label" },
    ],
    layer: [{
      mark: { type: "line", point: { filled: true, size: 52 }, strokeWidth: 1.5 },
      encoding: {
        x: { field: "__period_label", type: "ordinal", sort: [startLabel, endLabel], axis: { title: null, orient: "top", grid: false, labelFontWeight: "bold" } },
        y: { field: "__value", type: "quantitative", axis: { title: null, ...(format ? { format } : {}) }, scale: { zero: false } },
        detail: { field: block.categoryColumn },
        color,
        tooltip: [tooltip(block.categoryColumn, "nominal"), tooltip("__period_label", "nominal"), tooltip("__value", "quantitative", format)],
      },
    }, {
      transform: [{ filter: `datum.__period === ${JSON.stringify(block.endColumn)}` }],
      mark: { type: "text", align: "left", dx: 8, fontSize: 10 },
      encoding: {
        x: { field: "__period_label", type: "ordinal", sort: [startLabel, endLabel] },
        y: { field: "__value", type: "quantitative" },
        text: { field: block.categoryColumn, type: "nominal" },
        color,
      },
    }],
    padding: { left: 5, right: 80, top: 5, bottom: 5 },
    config: cleanConfig,
  };
}

function rangeDotSpec(block: ReportRangeDotBlock): Record<string, any> {
  const format = quantitativeFormat(block.format);
  const y = { field: block.categoryColumn, type: "nominal", sort: null, axis: { title: null, grid: false } };
  const layers: Record<string, any>[] = [{
    mark: { type: "rule", color: MUTED, strokeWidth: 2 },
    encoding: {
      y,
      x: { field: block.lowColumn, type: "quantitative", axis: { title: null, ...(format ? { format } : {}) } },
      x2: { field: block.highColumn },
      tooltip: [tooltip(block.categoryColumn, "nominal"), tooltip(block.lowColumn, "quantitative", format), tooltip(block.highColumn, "quantitative", format)],
    },
  }, {
    transform: [{ fold: [block.lowColumn, block.highColumn], as: ["__bound", "__bound_value"] }],
    mark: { type: "point", filled: true, size: 42, color: INK },
    encoding: { y, x: { field: "__bound_value", type: "quantitative" } },
  }];
  if (block.valueColumn) {
    layers.push({
      mark: { type: "point", filled: true, size: 75, color: block.color ?? BLUE, stroke: "white", strokeWidth: 1 },
      encoding: {
        y,
        x: { field: block.valueColumn, type: "quantitative" },
        tooltip: [tooltip(block.categoryColumn, "nominal"), tooltip(block.valueColumn, "quantitative", format)],
      },
    });
  }
  return { layer: layers, config: cleanConfig };
}

export function isReportTufteBlock(block: ReportBlock): block is ReportTufteBlock {
  return ["small_multiples", "bullet", "slopegraph", "range_dot"].includes(block.type);
}

export function tufteBlockToVegaSpec(block: ReportTufteBlock): Record<string, any> {
  if (block.type === "small_multiples") return smallMultiplesSpec(block);
  if (block.type === "bullet") return bulletSpec(block);
  if (block.type === "slopegraph") return slopegraphSpec(block);
  return rangeDotSpec(block);
}
