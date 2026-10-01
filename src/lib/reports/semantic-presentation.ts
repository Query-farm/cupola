import type { SemanticPlan } from "../semantic-compiler";

export type SemanticOutput = NonNullable<SemanticPlan["outputs"]>[number];

export function semanticOutputLabel(
  output: SemanticOutput | undefined,
  fallback: string,
): string {
  const title = output?.title || fallback.replaceAll("_", " ");
  return output?.unit && output.unit !== "1"
    ? `${title} (${output.unit})`
    : title;
}
