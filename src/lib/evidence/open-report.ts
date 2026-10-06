import { appBase } from '../app-base';

// Its own module: the app shell imports it, and must not pull in the report schemas.

/** Open a saved report (or, without an id, the saved-reports list) inside the app, without a page
 *  load: the sidebar dispatches it, the app switches to the Reports tab, and the workspace opens it.
 *  `href` is the report's URL, for a workspace that hasn't mounted yet to read on its first render. */
export const OPEN_REPORT_EVENT = 'cupola:open-report';
export interface OpenReportDetail { serviceUrl: string; workspaceId?: string; id?: string; href: string }

/** A saved report's URL in this tab's workspace (or, without an id, the saved-reports list), as the
 *  sidebar links it: `?local_ws=` when the tab names a workspace, else `?service=`. */
export function reportHref(serviceUrl: string, id?: string): string {
  const base = `${appBase.replace(/\/$/, '')}/reports`;
  const localWs = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('local_ws');
  return `${base}${id ? '' : '/saved'}?${new URLSearchParams({ ...(localWs ? { local_ws: localWs } : { service: serviceUrl }), ...(id ? { evidence_report: id } : {}) })}`;
}
