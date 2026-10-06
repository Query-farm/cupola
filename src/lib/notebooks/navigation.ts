import { appBase } from '../app-base';
import type { Callable } from '../callable';
export type NotebookInsertion = { token: number; serviceUrl: string } & (
  { text: string; callable?: never } | { callable: Callable; text?: never }
);
export const OPEN_NOTEBOOK_EVENT = 'cupola:open-notebook';
export interface OpenNotebookDetail {
  serviceUrl: string;
  id?: string;
  create?: boolean;
}
export interface NotebookNavigation extends OpenNotebookDetail {
  token: number;
  fromHistory?: boolean;
}
/** A notebook's URL in this tab's workspace (or, without an id, the library):
 *  `?local_ws=` when the tab names a workspace, else `?service=`, like `reportHref`. */
export function notebookHref(serviceUrl: string, id?: string): string {
  const localWs = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('local_ws');
  const params = new URLSearchParams({ ...(localWs ? { local_ws: localWs } : { service: serviceUrl }), ...(id ? { notebook: id } : {}) });
  if (typeof window !== 'undefined') {
    const version = new URLSearchParams(window.location.search).get('vgi_version');
    if (version) params.set('vgi_version', version);
  }
  return `${appBase.replace(/\/$/, '')}/notebooks?${params}`;
}
