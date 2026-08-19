import { describe, expect, test } from "bun:test";
import { evaluateReportAgentCase, evaluateReportAgentTrace, REPORT_AGENT_EVAL_CASES } from "../../src/lib/reports/agent-evals";

describe("report agent evaluations", () => {
  test("maintains representative authoring cases", () => {
    expect(REPORT_AGENT_EVAL_CASES.map((item) => item.id)).toEqual(expect.arrayContaining([
      "parameterized-weather",
      "two-city-groups",
      "repair-invalid-chart",
      "executive-narrative",
    ]));
    expect(REPORT_AGENT_EVAL_CASES.every((item) => item.expected.requiresPlan && item.expected.requiresSuccessfulFinalize)).toBe(true);
  });

  test("passes a planned, repaired, successfully finalized trace", () => {
    const result = evaluateReportAgentTrace([
      { tool: "list_tables", ok: true },
      { tool: "plan_report", ok: true },
      { tool: "configure_report", ok: true },
      { tool: "upsert_report_dataset", target: "weather", ok: false },
      { tool: "upsert_report_dataset", target: "weather", ok: true },
      { tool: "upsert_report_block", target: "temperature", ok: true },
      { tool: "finalize_report", ok: true },
    ]);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  test("fails traces that skip planning, leave repairs open, or mutate after finalization", () => {
    const result = evaluateReportAgentTrace([
      { tool: "configure_report", ok: true },
      { tool: "upsert_report_block", target: "temperature", ok: false },
      { tool: "finalize_report", ok: true },
      { tool: "upsert_report_dataset", target: "weather", ok: true },
    ]);
    expect(result.passed).toBe(false);
    expect(result.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.id)).toEqual(expect.arrayContaining([
      "plan_before_mutation",
      "repairs_completed",
      "no_mutation_after_finalize",
    ]));
  });

  test("scores both the authoring process and resulting report shape", () => {
    const evaluationCase = REPORT_AGENT_EVAL_CASES.find((item) => item.id === "parameterized-weather")!;
    const trace = [
      { tool: "plan_report", ok: true },
      { tool: "configure_report", ok: true },
      { tool: "upsert_report_dataset", target: "weather", ok: true },
      { tool: "upsert_report_block", target: "humidity", ok: true },
      { tool: "finalize_report", ok: true },
    ];
    const passing = evaluateReportAgentCase({
      parameters: [{ key: "location" }],
      blocks: [{ type: "kpi" }, { type: "sparkline" }, { type: "chart" }],
    }, trace, evaluationCase);
    expect(passing.passed).toBe(true);

    const failing = evaluateReportAgentCase({ parameters: [], blocks: [{ type: "table" }] }, trace, evaluationCase);
    expect(failing.passed).toBe(false);
    expect(failing.outcome.filter((criterion) => !criterion.passed).map((criterion) => criterion.id)).toEqual(["expected_parameters", "expected_block_types"]);
  });
});
