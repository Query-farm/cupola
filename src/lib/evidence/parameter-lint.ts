import { scanReportQuery } from '../reports/parameters';
import type { EvidenceIssue } from './editor-support';
import { parameterGraphErrors } from './parameter-graph';
import { hasChoices } from './parameters';
import type { EvidenceReport } from './reports';
import { sourceQueries } from './source-queries';

/** Problems with a report's parameters, found without running anything: references to missing
 *  parameters, choice queries that loop, unused parameters, names an Evidence input also uses,
 *  and drill levels a click could never match. Recomputed on every edit. */
export function parameterLint(report: EvidenceReport): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [];
  const binder = { parameters: report.parameters.map(p => ({ id: p.id, key: p.key, label: p.label, type: p.type, defaultValue: null })) };
  const used = new Set<string>();
  const unknownMessage = (where: string, token: string) => {
    const range = report.parameters.find(p => p.key === token && p.type === 'date_range');
    return range ? `${where} uses $${token}; a date range is $${token}_start or $${token}_end.` : `${where} uses $${token}, which is not a parameter.`;
  };
  if (report.setupSql.trim()) {
    const scan = scanReportQuery(report.setupSql, binder);
    scan.references.forEach(key => used.add(key));
    for (const token of scan.unknown) issues.push({ message: unknownMessage('Setup SQL', token), severity: 'error', target: 'data' });
  }
  for (const query of sourceQueries(report.source)) {
    const scan = scanReportQuery(query.sql, binder);
    scan.references.forEach(key => used.add(key));
    for (const token of scan.unknown) issues.push({ message: unknownMessage(`Query "${query.name || 'unnamed'}"`, token), severity: 'error', target: 'document', line: query.line });
  }
  for (const parameter of report.parameters) {
    if (parameter.options?.kind === 'query') scanReportQuery(parameter.options.sql, binder).references.forEach(key => used.add(key));
  }
  for (const message of parameterGraphErrors(report)) issues.push({ message, severity: 'error', target: 'data' });
  for (const path of report.drillPaths ?? []) {
    path.levels.forEach(key => used.add(key));
    for (const key of path.levels) {
      const level = report.parameters.find(p => p.key === key);
      if (!level) issues.push({ message: `Drill path ${path.label || path.id}: "${key}" is not a parameter.`, severity: 'error', target: 'data' });
      else if (!hasChoices(level) && level.type !== 'text') issues.push({ message: `Drill path ${path.label || path.id}: ${level.label} has no choices, so a click can't be matched to a value. Make it a select.`, severity: 'warning', target: 'data' });
      else if (hasChoices(level) && !level.options) issues.push({ message: `Drill path ${path.label || path.id}: ${level.label} has no choices yet.`, severity: 'warning', target: 'data' });
    }
  }
  for (const parameter of report.parameters) {
    const key = parameter.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Evidence refers to parameters through its own filter syntax too: filters=["key"], {{key}}.
    if (new RegExp(`["']${key}["']|\\{\\{\\s*${key}\\b`).test(report.source)) used.add(parameter.key);
    if (new RegExp(`\\bid\\s*=\\s*["']${key}["']`).test(report.source)) {
      issues.push({ message: `Parameter "${parameter.key}" has the same name as an Evidence input in the document; rename one of them.`, severity: 'error', target: 'document' });
    }
    if (!used.has(parameter.key)) issues.push({ message: `${parameter.label} isn't used by any SQL, choices query, drill path or Evidence filter.`, severity: 'warning', target: 'data' });
  }
  return issues;
}
