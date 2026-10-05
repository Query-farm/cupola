/* ── Recent services (localStorage) ──
 *
 * A store of previously-connected VGI service URLs (most-recent first) so the
 * frontend can offer quick switching between them. Entries are updated on
 * every successful catalog fetch (see `CatalogApp.loadCatalog`) and surfaced
 * by both the welcome page and the header ServiceSwitcher.
 *
 * The full history is kept — users can connect to many VGI servers and want
 * all of them available. Entries are de-duplicated by URL, so the list only
 * grows with the number of *distinct* servers ever visited (naturally small),
 * not with the number of connections. The welcome page shows the latest few
 * and lets the user expand/filter to reach the rest.
 */

import { isSecretOption, SECRET_NAME_RE } from "./attach/options";
import { parsePlainLiteral, splitLegacyOptions } from "./attach/legacy-options";
import { saveSecrets } from "./attach/secret-store";

const RECENT_SERVICES_KEY = "vgi-recent-services";

export interface RecentService {
  url: string;
  catalogName: string;
  /** ISO timestamp of last successful connection. */
  lastUsed: string;
  /** Structured ATTACH options, name → DuckDB text value. Never a secret:
   *  those live in `lib/attach/secret-store.ts`. */
  options?: Record<string, string>;
  /** Raw option text still to be migrated (`lib/attach/legacy-options.ts`):
   *  a pre-structured `attachOptions` entry, or expressions the user agreed to
   *  that need the engine to evaluate. Never spliced into SQL. */
  rawOptions?: string;
}

/** What older builds stored: the raw fragment that used to be spliced into
 *  the ATTACH statement. */
interface StoredRecentService extends RecentService {
  attachOptions?: string;
}

export function getRecentServices(): RecentService[] {
  try {
    const raw = localStorage.getItem(RECENT_SERVICES_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredRecentService[];
    if (!Array.isArray(list)) return [];
    if (!list.some((s) => s.attachOptions !== undefined)) return list;
    const migrated = list.map(migrateLegacyEntry);
    localStorage.setItem(RECENT_SERVICES_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {}
  return [];
}

/** Migrate a pre-structured entry once, at first read: plain literal values
 *  become structured options, credential-named ones move to the secret store
 *  (so a stored secret stops sitting in this list), and anything that needs
 *  the engine stays as `rawOptions` for the connect-time migration, which
 *  also reports what it cannot use. */
function migrateLegacyEntry(entry: StoredRecentService): RecentService {
  const { attachOptions, ...rest } = entry;
  if (!attachOptions?.trim()) return rest;
  const { entries, problems } = splitLegacyOptions(attachOptions);
  const options: Record<string, string> = { ...(rest.options ?? {}) };
  const secrets: Record<string, string> = {};
  const pending: string[] = rest.rawOptions ? [rest.rawOptions] : [];
  for (const { name, expr } of entries) {
    const plain = parsePlainLiteral(expr);
    if (plain === null) pending.push(`${name} ${expr}`);
    else if (isSecretOption(name)) secrets[name] = plain;
    else options[name] = plain;
  }
  // Unparseable text is kept for the connect-time report, unless it may hold
  // a credential, which is dropped rather than left here in the clear.
  for (const p of problems) if (!SECRET_NAME_RE.test(p.text)) pending.push(p.text);
  if (Object.keys(secrets).length) saveSecrets(rest.url, rest.catalogName ?? "", secrets);
  const next: RecentService = { ...rest, options, rawOptions: pending.join(", ") };
  if (!Object.keys(options).length) delete next.options;
  if (!next.rawOptions) delete next.rawOptions;
  return next;
}

export interface RecentServiceUpdate {
  /** Replaces the stored options; `{}` clears them. Omit to keep them. */
  options?: Record<string, string>;
  /** Replaces the pending raw text; `""` clears it. Omit to keep it. */
  rawOptions?: string;
}

/**
 * Save / update a recent service entry.
 *
 * `catalogName` and each field of `update` are independently preserved when
 * omitted (`""` for the name) — the welcome form saves options before the
 * catalog name is known, and `loadCatalog` later fills in the name without
 * clobbering them.
 */
export function saveRecentService(
  url: string,
  catalogName: string,
  update: RecentServiceUpdate = {},
): void {
  try {
    const list = getRecentServices();
    const prior = list.find((s) => s.url === url);
    const next: RecentService = {
      url,
      catalogName: catalogName || prior?.catalogName || "",
      lastUsed: new Date().toISOString(),
      options: update.options !== undefined ? update.options : prior?.options,
      rawOptions: update.rawOptions !== undefined ? update.rawOptions : prior?.rawOptions,
    };
    if (!next.options || Object.keys(next.options).length === 0) delete next.options;
    if (!next.rawOptions) delete next.rawOptions;
    const filtered = list.filter((s) => s.url !== url);
    filtered.unshift(next);
    localStorage.setItem(RECENT_SERVICES_KEY, JSON.stringify(filtered));
  } catch {}
}

export function getRecentService(url: string): RecentService | undefined {
  return getRecentServices().find((s) => s.url === url);
}

/** A short, secret-free summary of a recent's options for list rows. Raw
 *  text still awaiting migration is not shown: it has not been checked for
 *  credentials by the catalog's specs yet. */
export function describeRecentOptions(service: RecentService): string {
  const parts = Object.entries(service.options ?? {}).map(([k, v]) => `${k} ${v}`);
  if (service.rawOptions) parts.push("…");
  return parts.join(", ");
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
