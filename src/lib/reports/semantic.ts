import type { CatalogData } from "../service";
import { buildSemanticEnvironment } from "../semantic-model";
import type { SemanticCompileResult, SemanticPlan, SemanticQuery } from "../semantic-compiler";
import { compileSemanticQuery } from "../semantic-compiler";
import type {
  ReportDocumentV1,
  ReportParameter,
  ReportParameterValue,
  ReportSemanticDataset,
  ReportSemanticParameterRef,
  ReportSemanticQueryTemplate,
} from "./types";

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isReportSemanticParameterRef(value: unknown): value is ReportSemanticParameterRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return typeof value.report_parameter === "string"
    && keys.every((key) => key === "report_parameter" || key === "part")
    && (value.part === undefined || value.part === "start" || value.part === "end");
}

function parameterValue(
  parameter: ReportParameter,
  values: Record<string, ReportParameterValue>,
  part?: "start" | "end",
): unknown {
  const value = values[parameter.key] ?? parameter.defaultValue;
  if (part) {
    if (parameter.type !== "date_range") throw new Error(`Report parameter '${parameter.key}' is not a date range`);
    if (!isRecord(value)) return null;
    return (value as { start?: string | null; end?: string | null })[part] ?? null;
  }
  if (parameter.type === "date_range") throw new Error(`Date range report parameter '${parameter.key}' requires part 'start' or 'end'`);
  return structuredClone(value);
}

/** Resolve tagged values recursively without ever treating arbitrary objects
 * as executable input. The semantic schema/compiler validates the resulting
 * request independently. */
export function resolveReportSemanticQuery(
  template: ReportSemanticQueryTemplate,
  report: Pick<ReportDocumentV1, "parameters">,
  values: Record<string, ReportParameterValue>,
): SemanticQuery {
  const byKey = new Map(report.parameters.map((parameter) => [parameter.key, parameter]));
  const visit = (value: unknown): unknown => {
    if (isReportSemanticParameterRef(value)) {
      const parameter = byKey.get(value.report_parameter);
      if (!parameter) throw new Error(`Unknown report parameter '${value.report_parameter}' in semantic query`);
      return parameterValue(parameter, values, value.part);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return visit(template) as SemanticQuery;
}

export function semanticParameterReferences(template: ReportSemanticQueryTemplate): ReportSemanticParameterRef[] {
  const references: ReportSemanticParameterRef[] = [];
  const visit = (value: unknown) => {
    if (isReportSemanticParameterRef(value)) { references.push(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(template);
  return references;
}

function normalizedMember(member: any) {
  return Object.fromEntries(Object.entries(member).filter(([key]) => key !== "hidden").sort(([left], [right]) => left.localeCompare(right)));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fingerprint the normalized semantic contracts reachable through the
 * compiled plan. Attachment aliases are deliberately excluded so a shared
 * report remains portable when catalogs are attached under other names. */
export async function fingerprintSemanticPlan(
  catalogs: readonly CatalogData[],
  plan: SemanticPlan,
): Promise<string> {
  const environment = buildSemanticEnvironment(catalogs);
  const entityKeys = new Set((plan.model_dependencies?.entities ?? []).map((entity) => `${entity.catalog_id}::${entity.entity_id}`));
  if (!entityKeys.size) for (const marker of plan.fact_branches.flatMap((branch) => branch.entities)) {
    const separator = marker.indexOf(":");
    entityKeys.add(separator >= 0 ? marker.slice(separator + 1) : marker);
  }
  for (const branch of plan.fact_branches) entityKeys.add(`${branch.root.catalog_id}::${branch.root.entity_id}`);
  const entities = environment.entities
    .filter((entity) => entityKeys.has(entity.key))
    .map((entity) => ({
      catalog_id: entity.catalogId,
      entity_id: entity.entityId,
      source_kind: entity.sourceKind,
      source_name: entity.sourceName,
      grain: entity.grain,
      default_time_dimension: entity.defaultTimeDimension,
      source_arguments: entity.sourceArguments,
      function_arguments: entity.functionArguments,
      function_overload_count: entity.functionOverloadCount,
      input_from_args: entity.inputFromArgs,
      required_filters: entity.requiredFilters,
      members: [...entity.members.values()].map(normalizedMember).sort((a, b) => String(a.member_id).localeCompare(String(b.member_id))),
    }))
    .sort((a, b) => `${a.catalog_id}::${a.entity_id}`.localeCompare(`${b.catalog_id}::${b.entity_id}`));
  const included = new Set(entities.map((entity) => `${entity.catalog_id}::${entity.entity_id}`));
  const relationshipIds = new Set(plan.model_dependencies?.relationships ?? []);
  const relationships = environment.relationships
    .filter((relationship) => relationshipIds.size
      ? relationshipIds.has(relationship.relationshipId)
      : included.has(`${relationship.from.catalog_id}::${relationship.from.entity_id}`)
        && included.has(`${relationship.to.catalog_id}::${relationship.to.entity_id}`))
    .map(({ hostAliases: _aliases, ...relationship }) => relationship)
    .sort((a, b) => a.relationshipId.localeCompare(b.relationshipId));
  return `sha256:${await sha256(stable({ entities, relationships }))}`;
}

export interface PreparedSemanticReportDataset {
  request: SemanticQuery;
  compilation: SemanticCompileResult;
  fingerprint?: string;
  modelChanged: boolean;
}

export async function prepareSemanticReportDataset(
  dataset: ReportSemanticDataset,
  report: Pick<ReportDocumentV1, "parameters">,
  values: Record<string, ReportParameterValue>,
  catalogs: readonly CatalogData[],
): Promise<PreparedSemanticReportDataset> {
  const request = resolveReportSemanticQuery(dataset.query, report, values);
  const compilation = compileSemanticQuery(catalogs, { ...request, compile_only: true });
  if (!compilation.ok) return { request, compilation, modelChanged: false };
  const fingerprint = await fingerprintSemanticPlan(catalogs, compilation.plan);
  return {
    request,
    compilation,
    fingerprint,
    modelChanged: Boolean(dataset.acceptedModelFingerprint && dataset.acceptedModelFingerprint !== fingerprint),
  };
}
