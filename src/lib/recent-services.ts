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
  /** Free-form raw SQL fragment spliced into the ATTACH parens after LOCATION. */
  attachOptions?: string;
}

export function getRecentServices(): RecentService[] {
  try {
    const raw = localStorage.getItem(RECENT_SERVICES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

/**
 * Save / update a recent service entry.
 *
 * `attachOptions` and `catalogName` are independently preserved when the
 * caller passes `undefined` / `""` — this lets the welcome form persist
 * options before a catalog name is known, and lets `loadCatalog` later fill
 * in the catalog name without clobbering the user's options.
 */
export function saveRecentService(
  url: string,
  catalogName: string,
  attachOptions?: string,
): void {
  try {
    const list = getRecentServices();
    const prior = list.find((s) => s.url === url);
    const next: RecentService = {
      url,
      catalogName: catalogName || prior?.catalogName || "",
      lastUsed: new Date().toISOString(),
      attachOptions: attachOptions !== undefined ? attachOptions : prior?.attachOptions,
    };
    if (next.attachOptions === "" || next.attachOptions === undefined) {
      delete next.attachOptions;
    }
    const filtered = list.filter((s) => s.url !== url);
    filtered.unshift(next);
    localStorage.setItem(RECENT_SERVICES_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT)));
  } catch {}
}

export function getAttachOptionsFor(url: string): string | undefined {
  return getRecentServices().find((s) => s.url === url)?.attachOptions;
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
