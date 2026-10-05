import { describeReportError, validateEvidenceReport, type EvidenceReport } from './reports';
import { compactHistory, emptyHistory, validateHistory, type ReportHistory } from './revisions';

/** A report file: one or more complete report specifications (source, setup SQL, parameters and
 *  their values, drill paths, semantic datasets, pivots, appearance) with each report's revision
 *  history, for moving reports between browsers and people. Reports are otherwise saved only in
 *  this browser's localStorage. Version 1 files have no history and still import.
 *
 *  Each report also carries its `requires` (the catalogs its SQL names, by alias, URL and server
 *  name). That field is additive and optional, so it needs no new version: a file without it
 *  imports as before, and an older Cupola reading a file with it drops the unknown key (zod strips
 *  it) rather than refusing the report. A malformed `requires` is dropped, not fatal. Importing
 *  keeps the file's `requires` as is, so opening the report can offer Rebind or Attach. */
export const REPORT_FILE_FORMAT = 'cupola-evidence-reports';
export const REPORT_FILE_VERSION = 2;
export const REPORT_FILE_EXTENSION = '.cupola-reports.json';

export interface ReportFile {
  format: typeof REPORT_FILE_FORMAT;
  version: typeof REPORT_FILE_VERSION;
  exportedAt: string;
  /** Each report, with its history beside its own fields. */
  reports: (EvidenceReport & { history?: ReportHistory })[];
}

export interface ReportFileEntry { report: EvidenceReport; history?: ReportHistory }

export function serializeReportFile(entries: ReportFileEntry[], now = new Date()): string {
  const file: ReportFile = {
    format: REPORT_FILE_FORMAT, version: REPORT_FILE_VERSION, exportedAt: now.toISOString(),
    reports: entries.map(({ report, history }) => history?.revisions.length ? { ...report, history: compactHistory(history) } : report),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/** Named after the report, or "cupola-reports" for several. */
export function reportFileName(reports: Pick<EvidenceReport, 'title'>[]): string {
  const stem = reports.length === 1
    ? reports[0].title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 80)
    : '';
  return `${stem || 'cupola-reports'}${REPORT_FILE_EXTENSION}`;
}

export interface ParsedReportFile {
  reports: EvidenceReport[];
  /** Each report's history, by the same index (empty when the file has none). */
  histories: ReportHistory[];
  /** Reports the file holds that could not be read, by title or position. */
  errors: string[];
}

const describe = describeReportError;

/** Read a report file. Also accepts a bare report, or an array of them, as saved in
 *  localStorage. Each report is validated on its own, so one bad report doesn't lose the rest. */
export function parseReportFile(text: string): ParsedReportFile {
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error('This is not a report file: it is not valid JSON.'); }
  let items: unknown[];
  if (Array.isArray(input)) items = input;
  else if (input && typeof input === 'object' && (input as { format?: unknown }).format === REPORT_FILE_FORMAT) {
    const file = input as { version?: unknown; reports?: unknown };
    if (typeof file.version !== 'number' || file.version > REPORT_FILE_VERSION) throw new Error('This report file was made by a newer version of Cupola. Update Cupola to import it.');
    if (!Array.isArray(file.reports)) throw new Error('This report file has no reports.');
    items = file.reports;
  } else if (input && typeof input === 'object' && 'source' in input && 'title' in input) items = [input];
  else throw new Error('This is not a Cupola report file.');
  const reports: EvidenceReport[] = [];
  const histories: ReportHistory[] = [];
  const errors: string[] = [];
  items.forEach((item, index) => {
    const title = item && typeof item === 'object' && typeof (item as { title?: unknown }).title === 'string' ? `“${(item as { title: string }).title}”` : `Report ${index + 1}`;
    let report: EvidenceReport;
    try { report = validateEvidenceReport(item); }
    catch (error) { errors.push(`${title}: ${describe(error)}`); return; }
    const raw = (item as { history?: unknown }).history;
    let history = emptyHistory();
    // A damaged history doesn't cost the report: it imports without it, and says so.
    if (raw !== undefined) {
      try { history = validateHistory(raw); }
      catch (error) { errors.push(`${title}: imported without its revision history (${describe(error)})`); }
    }
    reports.push(report);
    histories.push(history);
  });
  return { reports, histories, errors };
}

/** What importing a report does: save it as new, replace the saved one with its id, keep both
 *  (the import saved under a new id), or nothing (the saved one is the same report). */
export type ImportAction = 'new' | 'replace' | 'copy' | 'unchanged';
export interface PlannedImport { report: EvidenceReport; action: ImportAction; existing?: EvidenceReport }

/** The content that makes two reports the same, whatever was saved when and where. */
const spec = ({ createdAt: _c, updatedAt: _u, serviceUrl: _s, workspaceId: _w, requires: _r, ...rest }: EvidenceReport) => JSON.stringify(rest);

/** Plan an import into a workspace's saved reports (or, given a bare URL, a service's). Reports
 *  are saved against the workspace they are imported into, not the one they were exported from:
 *  the file is how a report moves between workers and workspaces as well as people. `replace`
 *  decides a changed report whose id is taken. */
export function planImport(incoming: EvidenceReport[], existing: EvidenceReport[], target: string | { serviceUrl: string; workspaceId?: string },
  replace: (existing: EvidenceReport, report: EvidenceReport) => boolean, newId: () => string = () => crypto.randomUUID()): PlannedImport[] {
  const saved = new Map(existing.map(report => [report.id, report]));
  const { serviceUrl, workspaceId } = typeof target === 'string' ? { serviceUrl: target, workspaceId: undefined } : target;
  return incoming.map(input => {
    const { workspaceId: _from, ...rest } = input;
    const report: EvidenceReport = { ...rest, serviceUrl, ...(workspaceId ? { workspaceId } : {}) };
    const match = saved.get(report.id);
    let planned: PlannedImport;
    if (!match) planned = { report, action: 'new' };
    else if (spec(match) === spec(report)) planned = { report, action: 'unchanged', existing: match };
    else if (replace(match, report)) planned = { report: { ...report, createdAt: match.createdAt }, action: 'replace', existing: match };
    else planned = { report: { ...report, id: newId(), title: `${report.title} (imported)`, createdAt: Date.now() }, action: 'copy', existing: match };
    // A file holding the same id twice: the second is compared with the first.
    saved.set(planned.report.id, planned.report);
    return planned;
  });
}
