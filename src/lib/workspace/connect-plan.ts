/** Pure decisions for the connect forms: which listed catalog to tick first,
 *  and what Connect opens (`?service=` or an untitled workspace). */
import type { OptionSpecInfo } from "../attach/options";

export interface DiscoveredCatalog {
  name: string;
  specs: OptionSpecInfo[];
}

/** The catalog to tick first: the one asked for (or stored) when the service
 *  still lists it, else the service's first, which is what `?service=` opens. */
export function initialCatalog(catalogs: readonly DiscoveredCatalog[], wanted?: string): string | null {
  const match = wanted ? catalogs.find((c) => c.name.toLowerCase() === wanted.toLowerCase()) : undefined;
  return match?.name ?? catalogs[0]?.name ?? null;
}

// ---------------------------------------------------------------------------
// What Connect opens
// ---------------------------------------------------------------------------

export interface ConnectSelection {
  url: string;
  /** The server's catalog name; "" when the service could not be asked. */
  catalogName: string;
  /** The service's first catalog, when it was listed. */
  firstCatalog: string | null;
}

export type ConnectPlan<T extends ConnectSelection = ConnectSelection> =
  | { kind: "service"; selection: T }
  | { kind: "workspace"; selections: T[] };

/** One catalog that `?service=` would open anyway (the service's first, or
 *  one never listed) keeps the `?service=` link; anything else is a
 *  workspace. The same catalog chosen twice is attached once. */
export function planConnect<T extends ConnectSelection>(selections: readonly T[]): ConnectPlan<T> | null {
  const seen = new Set<string>();
  const unique = selections.filter((s) => {
    const key = `${s.url.trim().replace(/\/+$/, "").toLowerCase()}\n${s.catalogName.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return null;
  const [only] = unique;
  if (unique.length === 1 && (only.firstCatalog === null || only.catalogName === only.firstCatalog)) {
    return { kind: "service", selection: only };
  }
  return { kind: "workspace", selections: unique };
}
