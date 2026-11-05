/** Fired on `window` when a report tries to navigate somewhere Cupola has no page; detail is the path. */
export const LINK_REFUSED_EVENT = 'cupola:evidence-link-refused';

/** Reports have no sibling pages, so a same-origin path outside the app's base is a 404 that
 * would take the reader out of Cupola. Other origins aren't refused here: the core only sends
 * internal paths to `goto`, and the page's own URL (fullscreen's query updates) stays allowed. */
export function isOutsideApp(target: URL, current: URL, base: string): boolean {
  if (target.origin !== current.origin || target.pathname === current.pathname) return false;
  return !target.pathname.startsWith(base);
}

export function linkRefusedNotice(path: string): string {
  return `The link to ${path} was not opened: reports have no page at that address. Link to a full https:// address instead, which opens in a new tab.`;
}
