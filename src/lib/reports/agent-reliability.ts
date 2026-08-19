import type { ReportBlock, ReportDocumentV1 } from "./types";

export interface ReportAgentPlanDataset {
  name: string;
  purpose: string;
}

export interface ReportAgentPlanBlock {
  type: ReportBlock["type"];
  title?: string;
  purpose: string;
  datasetName?: string;
}

export interface ReportAgentPlanParameter {
  key: string;
  type: string;
  purpose: string;
}

export interface ReportAgentPlan {
  objective: string;
  approach: string[];
  datasets: ReportAgentPlanDataset[];
  blocks: ReportAgentPlanBlock[];
  parameters: ReportAgentPlanParameter[];
  acceptanceCriteria: string[];
}

export interface ReportAgentCheckpoint {
  complete: boolean;
  completed: { datasets: number; blocks: number; parameters: number };
  planned: { datasets: number; blocks: number; parameters: number };
  missing: { datasets: string[]; blocks: string[]; parameters: string[] };
  nextAction: string;
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

export function parseReportAgentPlan(input: any): ReportAgentPlan {
  return {
    objective: String(input?.objective ?? "").trim(),
    approach: Array.isArray(input?.approach) ? input.approach.map(String).map((value: string) => value.trim()).filter(Boolean) : [],
    datasets: Array.isArray(input?.datasets) ? input.datasets.map((item: any) => ({ name: String(item.name ?? "").trim(), purpose: String(item.purpose ?? "").trim() })).filter((item: ReportAgentPlanDataset) => item.name && item.purpose) : [],
    blocks: Array.isArray(input?.blocks) ? input.blocks.map((item: any) => ({ type: String(item.type ?? "") as ReportBlock["type"], title: item.title == null ? undefined : String(item.title).trim(), purpose: String(item.purpose ?? "").trim(), datasetName: item.datasetName == null ? undefined : String(item.datasetName).trim() })).filter((item: ReportAgentPlanBlock) => item.type && item.purpose) : [],
    parameters: Array.isArray(input?.parameters) ? input.parameters.map((item: any) => ({ key: String(item.key ?? "").trim(), type: String(item.type ?? "").trim(), purpose: String(item.purpose ?? "").trim() })).filter((item: ReportAgentPlanParameter) => item.key && item.type && item.purpose) : [],
    acceptanceCriteria: Array.isArray(input?.acceptanceCriteria) ? input.acceptanceCriteria.map(String).map((value: string) => value.trim()).filter(Boolean) : [],
  };
}

export function validateReportAgentPlan(plan: ReportAgentPlan): string[] {
  const errors: string[] = [];
  if (!plan.objective) errors.push("The plan needs an objective.");
  if (!plan.approach.length) errors.push("The plan needs at least one implementation step.");
  if (!plan.acceptanceCriteria.length) errors.push("The plan needs at least one acceptance criterion.");
  const duplicateDatasets = plan.datasets.filter((item, index) => plan.datasets.findIndex((candidate) => normalized(candidate.name) === normalized(item.name)) !== index);
  if (duplicateDatasets.length) errors.push(`Dataset names must be unique: ${duplicateDatasets.map((item) => item.name).join(", ")}.`);
  const duplicateParameters = plan.parameters.filter((item, index) => plan.parameters.findIndex((candidate) => normalized(candidate.key) === normalized(item.key)) !== index);
  if (duplicateParameters.length) errors.push(`Parameter keys must be unique: ${duplicateParameters.map((item) => item.key).join(", ")}.`);
  return errors;
}

export function checkpointReportAgentPlan(plan: ReportAgentPlan, report: ReportDocumentV1): ReportAgentCheckpoint {
  const datasetNames = new Set(report.datasets.map((dataset) => normalized(dataset.name)));
  const parameterKeys = new Set(report.parameters.map((parameter) => normalized(parameter.key)));
  const unmatchedBlocks = [...report.blocks];
  const missingBlocks: string[] = [];
  let completedBlocks = 0;
  for (const planned of plan.blocks) {
    const index = unmatchedBlocks.findIndex((block) => block.type === planned.type && (!planned.title || normalized(block.title) === normalized(planned.title)));
    if (index >= 0) {
      completedBlocks++;
      unmatchedBlocks.splice(index, 1);
    } else {
      missingBlocks.push(planned.title ? `${planned.type}: ${planned.title}` : planned.type);
    }
  }
  const missingDatasets = plan.datasets.filter((item) => !datasetNames.has(normalized(item.name))).map((item) => item.name);
  const missingParameters = plan.parameters.filter((item) => !parameterKeys.has(normalized(item.key))).map((item) => item.key);
  const complete = !missingDatasets.length && !missingBlocks.length && !missingParameters.length;
  return {
    complete,
    completed: {
      datasets: plan.datasets.length - missingDatasets.length,
      blocks: completedBlocks,
      parameters: plan.parameters.length - missingParameters.length,
    },
    planned: { datasets: plan.datasets.length, blocks: plan.blocks.length, parameters: plan.parameters.length },
    missing: { datasets: missingDatasets, blocks: missingBlocks, parameters: missingParameters },
    nextAction: complete
      ? "Call finalize_report and correct every reported error until it returns ok=true."
      : `Complete the missing planned items: ${[...missingDatasets, ...missingBlocks, ...missingParameters].join(", ")}.`,
  };
}

export function reportAgentRepair(
  stage: "plan" | "configure" | "dataset" | "block" | "finalize",
  target: string,
  errors: string[],
  retryTool: string,
): Record<string, unknown> {
  return {
    ok: false,
    code: `report_${stage}_failed`,
    stage,
    target,
    errors: errors.map((message) => ({ message })),
    retry: {
      tool: retryTool,
      target,
      instruction: `Correct only ${target}, then call ${retryTool} again with the same identifier before continuing.`,
    },
  };
}
