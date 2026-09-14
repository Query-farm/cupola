import type { SemanticPlan } from "../semantic-compiler";
import type { ReportBlock } from "./types";

export type SemanticOutput = NonNullable<SemanticPlan["outputs"]>[number];
export type SemanticPresentation = Pick<
  SemanticPlan,
  "outputs" | "output_units"
>;

export function semanticOutput(
  plan: SemanticPresentation | undefined,
  name: string,
): SemanticOutput | undefined {
  const output = plan?.outputs?.find((item) => item.name === name);
  const unit =
    plan?.output_units && name in plan.output_units
      ? plan.output_units[name]
      : output?.unit;
  return output || unit != null
    ? { name, kind: "dimension", ...output, unit }
    : undefined;
}

export function semanticOutputLabel(
  output: SemanticOutput | undefined,
  fallback: string,
): string {
  const title = output?.title || fallback.replaceAll("_", " ");
  return output?.unit && output.unit !== "1"
    ? `${title} (${output.unit})`
    : title;
}

export function semanticVegaType(
  dataType?: string,
): "temporal" | "quantitative" | "nominal" | undefined {
  if (!dataType) return undefined;
  if (dataType.includes("[")) return "nominal";
  if (/^(DATE|TIMESTAMP|TIME)/i.test(dataType)) return "temporal";
  if (
    /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT\d*|FLOAT|DOUBLE|REAL|DECIMAL(?:\([\d, ]+\))?|NUMERIC(?:\([\d, ]+\))?)$/i.test(
      dataType.trim(),
    )
  )
    return "quantitative";
  return "nominal";
}

/** Supply display defaults at render time so model changes are reflected and
 * user-authored titles, formats, and chart encodings remain authoritative. */
export function semanticChartSpec(
  spec: Record<string, any>,
  plan?: SemanticPresentation,
): Record<string, any> {
  if (!plan) return spec;
  const visit = (node: any): any => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    // An explicit transform can change a column's meaning or units. Likewise,
    // a chart aggregate such as count no longer has the source measure's unit.
    if (node.transform?.length) return node;
    const next = { ...node };
    if (next.encoding)
      next.encoding = Object.fromEntries(
        Object.entries(next.encoding).map(([key, channel]) => {
          const decorate = (value: any) => {
            if (
              !value ||
              typeof value !== "object" ||
              typeof value.field !== "string" ||
              value.aggregate
            )
              return value;
            const output = semanticOutput(plan, value.field);
            if (!output) return value;
            return {
              ...value,
              title:
                value.title === undefined
                  ? semanticOutputLabel(output, value.field)
                  : value.title,
              ...(value.type === undefined && output.data_type
                ? { type: semanticVegaType(output.data_type) }
                : {}),
            };
          };
          return [
            key,
            Array.isArray(channel) ? channel.map(decorate) : decorate(channel),
          ];
        }),
      );
    for (const key of ["layer", "concat", "hconcat", "vconcat", "spec"])
      if (next[key]) next[key] = visit(next[key]);
    return next;
  };
  return visit(spec);
}

export function semanticBlockDefaults<T extends ReportBlock>(
  block: T,
  plan?: SemanticPresentation,
): T {
  if (!plan || block.type === "markdown") return block;
  const column =
    "valueColumn" in block
      ? block.valueColumn
      : "yColumn" in block
        ? block.yColumn
        : undefined;
  const output = column ? semanticOutput(plan, column) : undefined;
  return {
    ...block,
    ...(block.title === undefined && output
      ? { title: output.title || output.name.replaceAll("_", " ") }
      : {}),
    ...(block.type === "chart"
      ? { spec: semanticChartSpec(block.spec, plan) }
      : {}),
  } as T;
}

/** Units annotate the values returned by the model; they never imply a
 * conversion (in particular, a percentage must not be multiplied by 100). */
export function formatSemanticValue(
  value: unknown,
  unit: string | null | undefined,
  fallback: (value: unknown) => string,
): string {
  const formatted = fallback(value);
  if (value == null || !unit || unit === "1") return formatted;
  const symbols: Record<string, string> = { Cel: "°C", "[degF]": "°F" };
  return unit === "%"
    ? `${formatted}%`
    : `${formatted} ${symbols[unit] ?? unit}`;
}
