// Its own module: the app shell imports it, and must not pull in the report schemas.

/** Open a saved report (or, without an id, the saved-reports list) inside the app, without a page
 *  load: the sidebar dispatches it, the app switches to the Reports tab, and the workspace opens it.
 *  `href` is the report's URL, for a workspace that hasn't mounted yet to read on its first render. */
export const OPEN_REPORT_EVENT = 'cupola:open-report';
export interface OpenReportDetail { serviceUrl: string; workspaceId?: string; id?: string; href: string }
