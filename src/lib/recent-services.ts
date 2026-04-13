/* ── Recent services (localStorage) ──
 *
 * A small store of the most-recently-connected VGI service URLs so the
 * frontend can offer quick switching between them. Entries are updated on
 * every successful catalog fetch (see `CatalogApp.loadCatalog`) and surfaced
 * by both the welcome page and the header ServiceSwitcher.
 */

const RECENT_SERVICES_KEY = "vgi-recent-services";
const MAX_RECENT = 10;

export interface RecentService {
  url: string;
  catalogName: string;
  /** ISO timestamp of last successful connection. */
  lastUsed: string;
}

export function getRecentServices(): RecentService[] {
  try {
    const raw = localStorage.getItem(RECENT_SERVICES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function saveRecentService(url: string, catalogName: string): void {
  try {
    const list = getRecentServices().filter((s) => s.url !== url);
    list.unshift({ url, catalogName, lastUsed: new Date().toISOString() });
    localStorage.setItem(RECENT_SERVICES_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {}
}

export function removeRecentService(url: string): void {
  try {
    const list = getRecentServices().filter((s) => s.url !== url);
    localStorage.setItem(RECENT_SERVICES_KEY, JSON.stringify(list));
  } catch {}
}

/** Remove all recent services. Used by the sign-out page. */
export function clearAllRecentServices(): void {
  try {
    localStorage.removeItem(RECENT_SERVICES_KEY);
  } catch {}
}
