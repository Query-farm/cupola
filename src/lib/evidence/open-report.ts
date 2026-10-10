import { appBase } from '../app-base';

// Its own module: the app shell imports it, and must not pull in the report schemas.

/** Open a saved report, create a new one, or (without an id) open the saved-reports list without a page
 *  load: the sidebar dispatches it, the app switches to the Reports tab, and the workspace opens it.
 *  `href` is the report's URL, for a workspace that hasn't mounted yet to read on its first render. */
export const OPEN_REPORT_EVENT = 'cupola:open-report';
export interface OpenReportDetail { serviceUrl: string; workspaceId?: string; id?: string; create?: boolean; href: string; handled?: boolean }

/** A saved report's URL in this tab's workspace (or, without an id, the saved-reports list), as the
 *  sidebar links it: `?local_ws=` when the tab names a workspace, else `?service=`.
 *  `create` opens a blank report even when the Reports tab hasn't mounted yet. */
export function reportHref(serviceUrl: string, id?: string, create = false): string {
  const base = `${appBase.replace(/\/$/, '')}/reports`;
  const localWs = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('local_ws');
  return `${base}${id || create ? '' : '/saved'}?${new URLSearchParams({ ...(localWs ? { local_ws: localWs } : { service: serviceUrl }), report_service: 'local', ...(create ? { evidence_new: '1' } : id ? { evidence_report: id } : {}) })}`;
}
