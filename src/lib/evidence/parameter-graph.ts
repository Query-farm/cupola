import { scanReportQuery } from '../reports/parameters';
import type { EvidenceReport } from './reports';

type Parameters = Pick<EvidenceReport, 'parameters'>;

/** Which parameters each parameter's choices depend on: the `$refs` in its options query.
 *  Dependencies are inferred, never declared, so they can't drift from the SQL. */
export function parameterDependencies(report: Parameters): Map<string, string[]> {
  const binder = { parameters: report.parameters.map(p => ({ id: p.id, key: p.key, label: p.label, type: p.type, defaultValue: null })) };
  return new Map(report.parameters.map(parameter => {
    if (parameter.options?.kind !== 'query') return [parameter.key, []];
    return [parameter.key, scanReportQuery(parameter.options.sql, binder).references];
  }));
}

/** Unknown references, self-references and cycles among options queries. */
export function parameterGraphErrors(report: Parameters): string[] {
  const errors: string[] = [];
  const binder = { parameters: report.parameters.map(p => ({ id: p.id, key: p.key, label: p.label, type: p.type, defaultValue: null })) };
  for (const parameter of report.parameters) {
    if (parameter.options?.kind !== 'query') continue;
    const { references, unknown } = scanReportQuery(parameter.options.sql, binder);
    for (const token of unknown) {
      const range = report.parameters.find(p => p.key === token && p.type === 'date_range');
      errors.push(range
        ? `${parameter.label}: choices query must use $${token}_start or $${token}_end, not $${token}.`
        : `${parameter.label}: choices query uses $${token}, which is not a parameter.`);
    }
    if (references.includes(parameter.key)) errors.push(`${parameter.label}: choices query cannot use its own value ($${parameter.key}).`);
  }
  const cycle = findCycle(parameterDependencies(report));
  if (cycle) errors.push(`Parameter choices depend on each other in a loop: ${cycle.map(key => `$${key}`).join(' → ')}.`);
  return errors;
}

function findCycle(dependencies: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting'); stack.push(key);
    for (const parent of dependencies.get(key) ?? []) {
      if (parent === key) continue; // Reported as a self-reference.
      const found = visit(parent);
      if (found) return found;
    }
    stack.pop(); state.set(key, 'done');
    return null;
  };
  for (const key of dependencies.keys()) {
    const found = visit(key);
    if (found) return found;
  }
  return null;
}

/** Parameters ordered so each comes after everything its choices depend on. Assumes no cycle. */
export function parameterOrder(report: Parameters): string[] {
  const dependencies = parameterDependencies(report);
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const parent of dependencies.get(key) ?? []) if (parent !== key) visit(parent);
    order.push(key);
  };
  for (const parameter of report.parameters) visit(parameter.key);
  return order;
}

/** Every parameter whose choices change, directly or transitively, when `key` changes. */
export function parameterDependents(report: Parameters, key: string): string[] {
  const dependencies = parameterDependencies(report);
  const result = new Set<string>();
  const queue = [key];
  while (queue.length) {
    const current = queue.shift()!;
    for (const [child, parents] of dependencies) {
      if (child !== current && parents.includes(current) && !result.has(child)) { result.add(child); queue.push(child); }
    }
  }
  return parameterOrder(report).filter(k => result.has(k));
}
