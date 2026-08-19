import { describe, expect, test } from "bun:test";
import { matchesAppearanceRule, resolveReportAppearance } from "../../src/lib/reports/appearance";
import type { ReportAppearanceRule } from "../../src/lib/reports/types";

const rule = (overrides: Partial<ReportAppearanceRule> = {}): ReportAppearanceRule => ({
  column: "humidity",
  operator: "greater_than",
  value: 70,
  tone: "warning",
  label: "Above preferred range",
  ...overrides,
});

describe("report block appearance", () => {
  test("uses the first matching rule so severe thresholds can come first", () => {
    const appearance = resolveReportAppearance({
      tone: "neutral",
      rules: [
        rule({ value: 80, tone: "danger", emphasis: "prominent", label: "Critical" }),
        rule({ value: 60, tone: "warning", label: "Elevated" }),
      ],
    }, [{ humidity: 84 }]);
    expect(appearance).toEqual({ tone: "danger", emphasis: "prominent", label: "Critical", matchedRuleIndex: 0 });
  });

  test("supports any/all row matching and falls back when no rule matches", () => {
    expect(resolveReportAppearance({ rules: [rule({ rowMatch: "any" })] }, [{ humidity: 55 }, { humidity: 74 }]).tone).toBe("warning");
    expect(resolveReportAppearance({ tone: "success", label: "Normal", rules: [rule({ rowMatch: "all" })] }, [{ humidity: 74 }, { humidity: 55 }]))
      .toEqual({ tone: "success", emphasis: "subtle", label: "Normal" });
    expect(resolveReportAppearance({ tone: "success", label: "Normal", rules: [rule()] }, []))
      .toEqual({ tone: "neutral", emphasis: "subtle" });
  });

  test("handles inclusive ranges and scalar equality", () => {
    expect(matchesAppearanceRule(68, rule({ operator: "between", value: 60, value2: 70 }))).toBe(true);
    expect(matchesAppearanceRule("alert", rule({ operator: "equal", value: "alert" }))).toBe(true);
    expect(matchesAppearanceRule(null, rule({ operator: "equal", value: null }))).toBe(true);
  });
});
