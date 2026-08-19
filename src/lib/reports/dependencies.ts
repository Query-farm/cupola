import type { ReportDataset } from "./types";

export interface ReportDatasetExecutionPlan {
  /** Selected datasets in dependency-first order. */
  datasets: ReportDataset[];
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
  /** Selected datasets whose result must be materialized for a consumer. */
  materialized: Set<string>;
}

export type ReportTableNameParser = (sql: string) => Promise<string[]>;

function relationBaseName(relation: string): string {
  const part = relation.split(".").at(-1) ?? relation;
  return part.replace(/^"|"$/g, "").replaceAll('""', '');
}

function datasetKey(id: string): string {
  return id.toLocaleLowerCase("en-US");
}

/**
 * Infer report-local dependencies using DuckDB's own SQL parser. A dataset's
 * self-reference is deliberately treated as an external source: a common
 * report pattern is `{id: "weather", sql: "SELECT … FROM weather"}`.
 * References to every other dataset ID are report-local and reserve that
 * relation name for the duration of the refresh.
 */
export async function inferReportDatasetDependencies(
  datasets: ReportDataset[],
  parseTableNames: ReportTableNameParser,
  sqlForDataset: (dataset: ReportDataset) => string = (dataset) => dataset.sql,
): Promise<Map<string, Set<string>>> {
  const byKey = new Map(datasets.map((dataset) => [datasetKey(dataset.id), dataset.id]));
  const dependencies = new Map<string, Set<string>>();
  for (const dataset of datasets) {
    const refs = await parseTableNames(sqlForDataset(dataset));
    const ownKey = datasetKey(dataset.id);
    const inferred = new Set<string>();
    for (const relation of refs) {
      const key = datasetKey(relationBaseName(relation));
      const dependency = byKey.get(key);
      if (dependency && key !== ownKey) inferred.add(dependency);
    }
    dependencies.set(dataset.id, inferred);
  }
  return dependencies;
}

function invertDependencies(datasets: ReportDataset[], dependencies: Map<string, Set<string>>): Map<string, Set<string>> {
  const dependents = new Map(datasets.map((dataset) => [dataset.id, new Set<string>()]));
  for (const [datasetId, required] of dependencies) {
    for (const dependency of required) dependents.get(dependency)?.add(datasetId);
  }
  return dependents;
}

function addAncestors(selected: Set<string>, dependencies: Map<string, Set<string>>): void {
  const visit = (id: string) => {
    for (const dependency of dependencies.get(id) ?? []) {
      if (selected.has(dependency)) continue;
      selected.add(dependency);
      visit(dependency);
    }
  };
  for (const id of [...selected]) visit(id);
}

function addDescendants(selected: Set<string>, dependents: Map<string, Set<string>>): void {
  const visit = (id: string) => {
    for (const dependent of dependents.get(id) ?? []) {
      if (selected.has(dependent)) continue;
      selected.add(dependent);
      visit(dependent);
    }
  };
  for (const id of [...selected]) visit(id);
}

export function buildReportDatasetExecutionPlan(
  datasets: ReportDataset[],
  dependencies: Map<string, Set<string>>,
  requestedIds?: Set<string>,
  includeDependents = false,
): ReportDatasetExecutionPlan {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const dependents = invertDependencies(datasets, dependencies);
  const selected = requestedIds
    ? new Set([...requestedIds].filter((id) => byId.has(id)))
    : new Set(datasets.map((dataset) => dataset.id));
  if (includeDependents) addDescendants(selected, dependents);
  addAncestors(selected, dependencies);

  const ordered: ReportDataset[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (!selected.has(id) || visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), id];
      throw new Error(`Report dataset dependency cycle: ${cycle.join(" → ")}.`);
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    const dataset = byId.get(id);
    if (dataset) ordered.push(dataset);
  };
  // Preserve document order whenever the graph does not impose an order.
  for (const dataset of datasets) visit(dataset.id);

  const materialized = new Set<string>();
  for (const dataset of ordered) {
    if ([...(dependents.get(dataset.id) ?? [])].some((id) => selected.has(id))) materialized.add(dataset.id);
  }
  return { datasets: ordered, dependencies, dependents, materialized };
}

export function quoteReportDatasetIdentifier(id: string): string {
  return `"${id.replaceAll('"', '""')}"`;
}
