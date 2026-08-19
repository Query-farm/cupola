export interface ReportAgentEvalCase {
  id: string;
  prompt: string;
  expected: {
    parameterKeys?: string[];
    blockTypes: string[];
    requiresPlan: true;
    requiresSuccessfulFinalize: true;
  };
}

export const REPORT_AGENT_EVAL_CASES: ReportAgentEvalCase[] = [
  {
    id: "parameterized-weather",
    prompt: "Build a report for air quality and weather conditions in Glen Allen, Virginia, and let the reader change the location.",
    expected: { parameterKeys: ["location"], blockTypes: ["kpi", "sparkline", "chart"], requiresPlan: true, requiresSuccessfulFinalize: true },
  },
  {
    id: "two-city-groups",
    prompt: "Compare weather in Richmond and Norfolk with grouped KPIs and trends for each city.",
    expected: { blockTypes: ["kpi", "sparkline"], requiresPlan: true, requiresSuccessfulFinalize: true },
  },
  {
    id: "repair-invalid-chart",
    prompt: "Add a daily temperature range chart and correct any query or Vega-Lite errors before finishing.",
    expected: { blockTypes: ["chart"], requiresPlan: true, requiresSuccessfulFinalize: true },
  },
  {
    id: "executive-narrative",
    prompt: "Add an executive explanation of material changes using a compact aggregated dataset.",
    expected: { blockTypes: ["ai_narrative"], requiresPlan: true, requiresSuccessfulFinalize: true },
  },
];

export interface ReportAgentTraceEvent {
  tool: string;
  ok?: boolean;
  target?: string;
}

export interface ReportAgentTraceEvaluation {
  passed: boolean;
  score: number;
  criteria: Array<{ id: string; passed: boolean; detail: string }>;
}

export interface ReportAgentCaseEvaluation {
  passed: boolean;
  process: ReportAgentTraceEvaluation;
  outcome: Array<{ id: string; passed: boolean; detail: string }>;
}

const MUTATION_TOOLS = new Set(["configure_report", "upsert_report_group", "upsert_report_dataset", "upsert_report_block", "replace_report_draft"]);

/** Deterministic process evaluation for recorded or fixture agent traces. */
export function evaluateReportAgentTrace(events: ReportAgentTraceEvent[]): ReportAgentTraceEvaluation {
  const firstPlan = events.findIndex((event) => event.tool === "plan_report" && event.ok !== false);
  const firstMutation = events.findIndex((event) => MUTATION_TOOLS.has(event.tool));
  const finalSuccess = events.findLastIndex((event) => event.tool === "finalize_report" && event.ok === true);
  const mutationAfterFinalize = finalSuccess >= 0 && events.slice(finalSuccess + 1).some((event) => MUTATION_TOOLS.has(event.tool));
  const failedRepairs = events.flatMap((event, index) => {
    if (event.ok !== false || !MUTATION_TOOLS.has(event.tool)) return [];
    const repaired = events.slice(index + 1).some((candidate) => candidate.tool === event.tool && candidate.ok === true && (!event.target || candidate.target === event.target));
    return repaired ? [] : [`${event.tool}:${event.target ?? "unknown"}`];
  });
  const criteria = [
    { id: "plan_before_mutation", passed: firstPlan >= 0 && (firstMutation < 0 || firstPlan < firstMutation), detail: "A successful plan_report precedes report mutation." },
    { id: "compositional_authoring", passed: !events.some((event) => event.tool === "replace_report_draft"), detail: "The trace uses compositional tools instead of bulk replacement." },
    { id: "repairs_completed", passed: failedRepairs.length === 0, detail: failedRepairs.length ? `Unrepaired failures: ${failedRepairs.join(", ")}.` : "Every failed mutation is retried successfully." },
    { id: "successful_finalize", passed: finalSuccess >= 0, detail: "finalize_report returns ok=true." },
    { id: "no_mutation_after_finalize", passed: finalSuccess >= 0 && !mutationAfterFinalize, detail: "No report mutation occurs after successful finalization." },
  ];
  const score = criteria.filter((criterion) => criterion.passed).length / criteria.length;
  return { passed: criteria.every((criterion) => criterion.passed), score, criteria };
}

export function evaluateReportAgentCase(
  report: { parameters: Array<{ key: string }>; blocks: Array<{ type: string }> },
  trace: ReportAgentTraceEvent[],
  evaluationCase: ReportAgentEvalCase,
): ReportAgentCaseEvaluation {
  const process = evaluateReportAgentTrace(trace);
  const actualParameters = new Set(report.parameters.map((parameter) => parameter.key.toLocaleLowerCase()));
  const actualBlockTypes = new Set(report.blocks.map((block) => block.type));
  const missingParameters = (evaluationCase.expected.parameterKeys ?? []).filter((key) => !actualParameters.has(key.toLocaleLowerCase()));
  const missingBlockTypes = evaluationCase.expected.blockTypes.filter((type) => !actualBlockTypes.has(type));
  const outcome = [
    { id: "expected_parameters", passed: missingParameters.length === 0, detail: missingParameters.length ? `Missing parameters: ${missingParameters.join(", ")}.` : "Expected public parameters are present." },
    { id: "expected_block_types", passed: missingBlockTypes.length === 0, detail: missingBlockTypes.length ? `Missing block types: ${missingBlockTypes.join(", ")}.` : "Expected block types are present." },
  ];
  return { passed: process.passed && outcome.every((criterion) => criterion.passed), process, outcome };
}
