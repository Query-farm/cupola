export const REPORT_ROUTE_CHANGED = 'cupola:report-route-changed';
export const REPORT_LIBRARY_CHANGED = 'cupola:report-library-changed';

export interface ReportDestination { location: string; folderId?: string | null; reportId?: string }
export const reportNodeKey = ({ location, folderId, reportId }: ReportDestination) => JSON.stringify([location, reportId ? null : folderId ?? null, reportId ?? null]);

/** Retain the workspace connection, but never carry another report's revision or parameters. */
export function reportNavigationHref(serviceUrl: string, destination: ReportDestination, current: string = window.location.href, base = '/'): string {
  const url = new URL(current);
  const query = new URLSearchParams();
  const workspace = url.searchParams.get('local_ws');
  query.set(workspace ? 'local_ws' : 'service', workspace ?? serviceUrl);
  query.set('report_service', destination.location);
  if (destination.reportId) query.set(destination.location === 'local' ? 'evidence_report' : 'report_id', destination.reportId);
  if (destination.folderId) query.set(destination.location === 'local' ? 'local_report_folder' : 'report_folder', destination.folderId);
  return `${base.replace(/\/$/, '')}/reports?${query}`;
}

export function currentReportNode(search = window.location.search): string {
  const params = new URLSearchParams(search);
  const location = params.get('report_service') ?? (params.has('evidence_report') || params.has('evidence_new') ? 'local' : 'all');
  // Report ids identify leaves regardless of the folder hint in the URL.
  const reportId = params.get(location === 'local' ? 'evidence_report' : 'report_id') ?? undefined;
  return reportNodeKey({ location, reportId, folderId: reportId ? null : params.get(location === 'local' ? 'local_report_folder' : 'report_folder') });
}

/** A sidebar folder action survives lazy mounting, then is consumed once. */
export const reportFolderCreationRequested = () => new URLSearchParams(window.location.search).get('report_new_folder') === '1';
export function clearReportFolderCreation() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('report_new_folder')) return;
  url.searchParams.delete('report_new_folder'); history.replaceState(history.state, '', url);
}
