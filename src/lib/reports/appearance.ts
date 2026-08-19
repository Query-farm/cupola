import type { ReportAppearanceRule, ReportBlockAppearance, ReportBlockEmphasis, ReportBlockTone } from "./types";

export interface ResolvedReportAppearance {
  tone: ReportBlockTone;
  emphasis: ReportBlockEmphasis;
  label?: string;
  matchedRuleIndex?: number;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function equal(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (typeof left === "boolean" || typeof right === "boolean") return left === right;
  const leftNumber = numeric(left);
  const rightNumber = numeric(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber;
  return String(left) === String(right);
}

export function matchesAppearanceRule(value: unknown, rule: ReportAppearanceRule): boolean {
  if (rule.operator === "equal") return equal(value, rule.value);
  if (rule.operator === "not_equal") return !equal(value, rule.value);
  const actual = numeric(value);
  const threshold = numeric(rule.value);
  if (actual === null || threshold === null) return false;
  if (rule.operator === "less_than") return actual < threshold;
  if (rule.operator === "less_than_or_equal") return actual <= threshold;
  if (rule.operator === "greater_than") return actual > threshold;
  if (rule.operator === "greater_than_or_equal") return actual >= threshold;
  const upper = numeric(rule.value2);
  return upper !== null && actual >= Math.min(threshold, upper) && actual <= Math.max(threshold, upper);
}

export function resolveReportAppearance(
  appearance: ReportBlockAppearance | undefined,
  rows: Record<string, any>[],
): ResolvedReportAppearance {
  // A fallback describes evaluated data, not the loading state. Avoid showing
  // a reassuring green or alarming red card before the first query has run.
  if (appearance?.rules?.length && rows.length === 0) return { tone: "neutral", emphasis: "subtle" };
  const fallback: ResolvedReportAppearance = {
    tone: appearance?.tone ?? "neutral",
    emphasis: appearance?.emphasis ?? "subtle",
    label: appearance?.label,
  };
  for (const [index, rule] of (appearance?.rules ?? []).entries()) {
    const values = rows.map((row) => row?.[rule.column]);
    const matched = rule.rowMatch === "any"
      ? values.some((value) => matchesAppearanceRule(value, rule))
      : rule.rowMatch === "all"
        ? values.length > 0 && values.every((value) => matchesAppearanceRule(value, rule))
        : values.length > 0 && matchesAppearanceRule(values[0], rule);
    if (matched) return {
      tone: rule.tone,
      emphasis: rule.emphasis ?? appearance?.emphasis ?? "subtle",
      label: rule.label,
      matchedRuleIndex: index,
    };
  }
  return fallback;
}
