import type { ReportResult, ReportRow, Schedule, ScheduleV2 } from './contracts.generated';

/** UI compatibility model while the common library replaces report-only views.
 * The generated wire contracts remain unmodified and authoritative. */
export type LibraryRow = ReportRow & { object_kind?: string; creatable_kinds?: string[] };
export function documentKind(record: Pick<ReportRow, 'envelope'> & { object_kind?: string }): string {
  return record.object_kind ?? kindForFormat(record.envelope?.body_format ?? '');
}
export function kindForFormat(format: string): string {
  return format === 'cupola.query/1' ? 'query' : format === 'cupola.notebook/1' ? 'notebook' : 'report';
}
export function fromObject(value: any): any {
  if (Array.isArray(value)) return value.map(fromObject);
  if (!value || typeof value !== 'object') return value;
  if ('kinds' in value) return { ...value, body_formats: value.kinds.flatMap((k: any) => k.body_formats),
    root_allowed_actions: legacyActions(value.root_allowed_actions), protocol_version: '1.0.0' };
  return { ...value, ...('object_id' in value ? { report_id: value.object_id } : {}),
    ...('allowed_actions' in value ? { allowed_actions: legacyActions(value.allowed_actions) } : {}) };
}
function legacyActions(actions: string[]) { return actions.map(a => a === 'create_object' ? 'create_report' : a); }

export function toScheduleV2(schedule: Schedule): ScheduleV2 {
  const report = schedule.action.render_report;
  if (!report) throw new Error('This client supports scheduling report renders.');
  return { ...schedule, action: { ...schedule.action, run_query: null, render_report: {
    source: { service_url: report.report.service_url, object_id: report.report.report_id },
    selection: { mode: report.track, revision_id: report.report.revision_id }, outputs: report.outputs,
  } } };
}
export function fromScheduleV2(value: any): any {
  if (Array.isArray(value)) return value.map(fromScheduleV2);
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (result.action?.render_report) {
    const r = result.action.render_report;
    result.action = { ...result.action, render_report: { report: { service_url: r.source.service_url, report_id: r.source.object_id, revision_id: r.selection.revision_id }, track: r.selection.mode, outputs: r.outputs } };
  }
  for (const key of ['definition', 'schedule', 'last_run']) if (result[key]) result[key] = fromScheduleV2(result[key]);
  if ('resolved_sources' in result) result.revision_id = result.resolved_sources[0]?.revision_id ?? null;
  return result;
}

export function asObjectResult(record: ReportResult) {
  return { ...record, object_id: record.report_id, object_kind: documentKind(record) };
}
