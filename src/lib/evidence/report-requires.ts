/**
 * Catalog aliases in Evidence reports (multi-catalog phase 3): where a report's SQL is, which
 * aliases it references, rewriting them (alias rename, Rebind), the `requires` list a report
 * records on save, and resolving that list against a workspace.
 *
 * **Only SQL is rewritten.** A report's SQL lives in its source's ```sql fences, its setup SQL,
 * and its parameters' choices queries. The rest of the source is Markdoc prose and `{% %}` tags:
 * `sales.total` in a sentence is not a reference, and a tag's `data="…"` names a query, never a
 * catalog. Semantic datasets are structured queries over the session's catalogs, not SQL text, and
 * are left alone. Fences are found by the CommonMark rules Markdoc follows (``` or ~~~, closed by
 * the same character at least as long), so an ```sql opener inside a ```markdown fence is text.
 *
 * Pure: unit-tested in tests/unit/report-requires.test.ts.
 */
import { findAliasReferences, rewriteAliases } from '../workspace/alias-rewrite';
import type { EvidenceReport, ReportRequirement } from './reports';

/** The content of each ```sql fence in a Markdoc source, as [start, end) offsets. */
export function sqlFenceRanges(source: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let open: { char: string; length: number; sql: boolean; contentStart: number } | null = null;
  let offset = 0;
  for (const line of source.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!open) {
      const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m || (m[1][0] === '`' && m[2].includes('`'))) continue;
      const language = m[2].trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      open = { char: m[1][0], length: m[1].length, sql: language === 'sql', contentStart: Math.min(offset, source.length) };
      continue;
    }
    const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (close && close[1][0] === open.char && close[1].length >= open.length) {
      if (open.sql) ranges.push({ start: open.contentStart, end: lineStart });
      open = null;
    }
  }
  // An unclosed fence runs to the end of the document.
  if (open?.sql) ranges.push({ start: open.contentStart, end: source.length });
  return ranges;
}

export type ReportSqlPart =
  | { where: 'source'; start: number; end: number; sql: string }
  | { where: 'setupSql'; sql: string }
  | { where: 'parameter'; parameterId: string; label: string; sql: string };

/** Every piece of SQL in a report. */
export function reportSqlParts(report: Pick<EvidenceReport, 'source' | 'setupSql' | 'parameters'>): ReportSqlPart[] {
  const parts: ReportSqlPart[] = sqlFenceRanges(report.source).map(range => ({ where: 'source', ...range, sql: report.source.slice(range.start, range.end) }));
  if (report.setupSql) parts.push({ where: 'setupSql', sql: report.setupSql });
  for (const parameter of report.parameters) {
    if (parameter.options?.kind === 'query') parts.push({ where: 'parameter', parameterId: parameter.id, label: parameter.label, sql: parameter.options.sql });
  }
  return parts;
}

export interface ReportAliasReference {
  where: ReportSqlPart['where'];
  /** For a parameter's choices query. */
  label?: string;
  /** 1-based, in the field it is in (the source for fences). */
  line: number;
  column: number;
  text: string;
}

/** References to catalog `alias` anywhere in a report's SQL. */
export function findReportAliasReferences(report: Pick<EvidenceReport, 'source' | 'setupSql' | 'parameters'>, alias: string): ReportAliasReference[] {
  const found: ReportAliasReference[] = [];
  for (const part of reportSqlParts(report)) {
    for (const ref of findAliasReferences(part.sql, alias).references) {
      if (part.where === 'source') {
        // Line and column in the whole source, not the fence.
        const before = report.source.slice(0, part.start + ref.start);
        const line = before.split('\n').length;
        found.push({ where: 'source', line, column: part.start + ref.start - before.lastIndexOf('\n'), text: ref.text });
      } else {
        found.push({ where: part.where, ...(part.where === 'parameter' ? { label: part.label } : {}), line: ref.line, column: ref.column, text: ref.text });
      }
    }
  }
  return found;
}

/** The report with its SQL's aliases rewritten (several at once, so swaps work) and its
 *  `requires` entries renamed to match. `count` is how many references changed. */
export function rewriteReportAliases<T extends Pick<EvidenceReport, 'source' | 'setupSql' | 'parameters' | 'requires'>>(report: T, mapping: Record<string, string>): { report: T; count: number } {
  let count = 0;
  let source = report.source;
  for (const range of [...sqlFenceRanges(source)].reverse()) {
    const rewritten = rewriteAliases(source.slice(range.start, range.end), mapping);
    count += rewritten.count;
    source = source.slice(0, range.start) + rewritten.text + source.slice(range.end);
  }
  const setup = rewriteAliases(report.setupSql, mapping);
  count += setup.count;
  const parameters = report.parameters.map(parameter => {
    if (parameter.options?.kind !== 'query') return parameter;
    const rewritten = rewriteAliases(parameter.options.sql, mapping);
    count += rewritten.count;
    return rewritten.count ? { ...parameter, options: { ...parameter.options, sql: rewritten.text } } : parameter;
  });
  const lower = new Map(Object.entries(mapping).map(([from, to]) => [from.toLowerCase(), to]));
  const requires = report.requires?.map(item => lower.has(item.alias.toLowerCase()) ? { ...item, alias: lower.get(item.alias.toLowerCase())! } : item);
  if (!count && JSON.stringify(requires) === JSON.stringify(report.requires)) return { report, count: 0 };
  return { report: { ...report, source, setupSql: setup.text, parameters, ...(requires ? { requires } : {}) }, count };
}

/** A workspace catalog, as far as `requires` cares. */
export interface RequireCatalog { alias: string; url: string; catalogName: string }

/** URLs compare without a trailing slash and with a lower-case scheme and host (as the store's). */
function sameUrl(a: string, b: string): boolean {
  const norm = (url: string) => {
    const trimmed = url.trim().replace(/\/+$/, '');
    const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(trimmed);
    return m ? `${m[1].toLowerCase()}${m[2].toLowerCase()}${m[3]}` : trimmed;
  };
  return norm(a) === norm(b);
}
const sameCatalog = (a: Pick<RequireCatalog, 'url' | 'catalogName'>, b: Pick<RequireCatalog, 'url' | 'catalogName'>) =>
  sameUrl(a.url, b.url) && a.catalogName.toLowerCase() === b.catalogName.toLowerCase();

/** What a report requires: each workspace catalog its SQL references by alias, and each earlier
 *  requirement its SQL still references whose alias this workspace doesn't have (a report opened
 *  "anyway" keeps saying what it was written for). Only qualified references count: SQL that
 *  names tables without a catalog reads the default catalog, whichever that is. */
export function deriveRequires(report: Pick<EvidenceReport, 'source' | 'setupSql' | 'parameters' | 'requires'>, catalogs: readonly RequireCatalog[]): ReportRequirement[] | undefined {
  const parts = reportSqlParts(report);
  const referenced = (alias: string) => parts.some(part => findAliasReferences(part.sql, alias).count > 0);
  const requires: ReportRequirement[] = [];
  const seen = new Set<string>();
  for (const catalog of catalogs) {
    if (!catalog.alias || seen.has(catalog.alias.toLowerCase()) || !referenced(catalog.alias)) continue;
    seen.add(catalog.alias.toLowerCase());
    requires.push({ alias: catalog.alias, url: catalog.url, catalogName: catalog.catalogName });
  }
  for (const previous of report.requires ?? []) {
    if (seen.has(previous.alias.toLowerCase()) || !referenced(previous.alias)) continue;
    seen.add(previous.alias.toLowerCase());
    requires.push(previous);
  }
  return requires.length ? requires : undefined;
}

/** The report with `requires` derived again; unchanged (same object) when nothing differs. */
export function withDerivedRequires<T extends Pick<EvidenceReport, 'source' | 'setupSql' | 'parameters' | 'requires'>>(report: T, catalogs: readonly RequireCatalog[]): T {
  const requires = deriveRequires(report, catalogs);
  if (JSON.stringify(requires) === JSON.stringify(report.requires)) return report;
  const { requires: _old, ...rest } = report;
  return (requires ? { ...rest, requires } : rest) as T;
}

export interface RequiresResolution {
  /** Every requirement is met by this workspace as it is. */
  ok: boolean;
  /** The same catalog is here under another alias: rewrite `from` to `to`. */
  rebind: { from: string; to: string; requirement: ReportRequirement }[];
  /** Neither the catalog nor its alias is in this workspace. */
  missing: ReportRequirement[];
}

/** Match a report's `requires` to a workspace's catalogs. A requirement is met by the same
 *  catalog (URL and server name) under the same alias; failing that, the same catalog under
 *  another alias is a rebind; failing that, a catalog with the same alias meets it (the report
 *  runs against whatever this workspace calls that, e.g. staging instead of production); and
 *  otherwise it is missing. */
export function resolveRequires(requires: readonly ReportRequirement[] | undefined, catalogs: readonly RequireCatalog[]): RequiresResolution {
  const rebind: RequiresResolution['rebind'] = [];
  const missing: RequiresResolution['missing'] = [];
  for (const requirement of requires ?? []) {
    const alias = requirement.alias.toLowerCase();
    if (catalogs.some(c => c.alias.toLowerCase() === alias && sameCatalog(c, requirement))) continue;
    const elsewhere = catalogs.find(c => c.alias && sameCatalog(c, requirement));
    if (elsewhere) { rebind.push({ from: requirement.alias, to: elsewhere.alias, requirement }); continue; }
    if (catalogs.some(c => c.alias.toLowerCase() === alias)) continue;
    missing.push(requirement);
  }
  return { ok: !rebind.length && !missing.length, rebind, missing };
}
