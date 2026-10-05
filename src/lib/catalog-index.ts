/**
 * Name lookup over the session's catalogs for the SQL editor: given the
 * identifier chain in front of a `(` (`fn`, `schema.fn`, `catalog.schema.fn`),
 * which callables could it mean? Built lazily and cached per inventory
 * snapshot, so a hover or keystroke never walks the whole catalog.
 */
import type { CatalogData } from "./service";
import { functionCallable, macroCallable, type Callable } from "./callable";

export interface CatalogIndex {
  /** Lowercased bare name → every callable with that name, primary catalog first. */
  byName: Map<string, Callable[]>;
}

const cache = new WeakMap<readonly CatalogData[], { builtins: CatalogData | null; index: CatalogIndex }>();

/** `builtins` is DuckDB's `system` catalog. For a bare name it ranks after the
 *  primary catalog and before the others, which is DuckDB's own order: the
 *  primary catalog is the session's default (Cupola `USE`s it), then `system`. */
export function buildCatalogIndex(catalogs: readonly CatalogData[], builtins: CatalogData | null = null): CatalogIndex {
  const hit = cache.get(catalogs);
  if (hit && hit.builtins === builtins) return hit.index;
  const byName = new Map<string, Callable[]>();
  const add = (c: Callable) => {
    const key = c.name.toLowerCase();
    const list = byName.get(key);
    if (list) list.push(c); else byName.set(key, [c]);
  };
  const ordered = [
    ...catalogs.filter((c) => c.primary),
    ...(builtins ? [builtins] : []),
    ...catalogs.filter((c) => !c.primary),
  ];
  for (const cat of ordered) {
    for (const schema of cat.schemas) {
      for (const f of schema.functions) add(functionCallable(cat.catalogName, f));
      for (const m of schema.macros ?? []) add(macroCallable(cat.catalogName, m));
    }
  }
  const index = { byName };
  cache.set(catalogs, { builtins, index });
  return index;
}

/** Callables an identifier chain can refer to. One part matches any schema;
 *  two parts are `schema.name` or `catalog.name`; three are exact. Matching is
 *  case-insensitive, like DuckDB's own resolution of unquoted names. */
export function resolveCallable(index: CatalogIndex, parts: readonly string[]): Callable[] {
  if (parts.length === 0 || parts.length > 3) return [];
  const name = parts[parts.length - 1].toLowerCase();
  const all = index.byName.get(name) ?? [];
  if (parts.length === 1) return all;
  const lower = parts.map((p) => p.toLowerCase());
  if (parts.length === 2) {
    return all.filter((c) => c.schema.toLowerCase() === lower[0] || c.catalog.toLowerCase() === lower[0]);
  }
  return all.filter((c) => c.catalog.toLowerCase() === lower[0] && c.schema.toLowerCase() === lower[1]);
}
