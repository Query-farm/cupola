/**
 * URL hash routing and page title management.
 *
 * Encodes the current selection into the URL hash so users can share links:
 *
 *   #/catalog/<alias>                                   a catalog's overview
 *   #/catalog/<alias>/schema/<s>                        a schema
 *   #/catalog/<alias>/schema/<s>/table/<t>              (view, function, macro alike)
 *   #/catalog/<alias>/relationships                     relationship explorer
 *   #/catalog/<alias>/schema/<s>/relationships[/table/<t>]
 *
 * The catalog segment is the DuckDB alias, so a link names the same object a
 * query would. Links written before several catalogs could be attached have no
 * catalog segment (`#/schema/<s>/table/<t>`); they still decode, to a
 * selection without `catalog`, which `resolveSelection` points at the default
 * catalog. A selection without a catalog is still encoded in that legacy form.
 */

import type { Selection } from "./tree";

const OBJECT_TYPES = ["table", "view", "function", "macro"] as const;
type ObjectType = typeof OBJECT_TYPES[number];

/** Encode a Selection into a URL hash string. */
export function selectionToHash(selection: Selection | null): string {
  if (!selection) return "";
  const e = encodeURIComponent;
  const prefix = selection.catalog ? `#/catalog/${e(selection.catalog)}` : "#";
  if (selection.type === "catalog") return selection.catalog ? prefix : "";
  if (selection.type === "relationships") {
    if (selection.schema && selection.focusTable) {
      return `${prefix}/schema/${e(selection.schema)}/relationships/table/${e(selection.focusTable)}`;
    }
    if (selection.schema) return `${prefix}/schema/${e(selection.schema)}/relationships`;
    return `${prefix}/relationships`;
  }
  if (selection.type === "schema") return `${prefix}/schema/${e(selection.name)}`;
  return `${prefix}/schema/${e(selection.schema!)}/${selection.type}/${e(selection.name)}`;
}

/** Decode the path after the optional catalog segment. */
function decodePath(parts: string[]): Omit<Selection, "catalog"> | null {
  if (parts.length === 1 && parts[0] === "relationships") {
    return { type: "relationships", name: "relationships" };
  }
  if (parts[0] !== "schema" || parts.length < 2 || !parts[1]) return null;
  const schema = parts[1];
  if (parts.length === 2) return { type: "schema", name: schema, schema };
  if (parts[2] === "relationships") {
    if (parts.length === 3) return { type: "relationships", name: "relationships", schema };
    if (parts.length === 5 && parts[3] === "table") {
      return { type: "relationships", name: "relationships", schema, focusTable: parts[4] };
    }
    return null;
  }
  if (parts.length === 4 && (OBJECT_TYPES as readonly string[]).includes(parts[2])) {
    return { type: parts[2] as ObjectType, name: parts[3], schema };
  }
  return null;
}

/** Decode a URL hash string into a Selection, or null for none. A legacy
 *  hash (no catalog segment) decodes without `catalog`. */
export function hashToSelection(hash: string): Selection | null {
  if (!hash || hash === "#" || hash === "#/") return null;
  const path = hash.replace(/^#\/?/, "");
  let parts: string[];
  try {
    parts = path.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }

  if (parts[0] === "catalog") {
    const catalog = parts[1];
    if (!catalog) return null;
    if (parts.length === 2) return { type: "catalog", name: catalog, catalog };
    const rest = decodePath(parts.slice(2));
    return rest ? { ...rest, catalog } : null;
  }
  return decodePath(parts);
}

/** Point a selection without a catalog (a legacy link, or a caller that
 *  predates catalogs) at the default catalog. */
export function resolveSelection(selection: Selection | null, defaultCatalog: string): Selection | null {
  if (!selection || selection.catalog) return selection;
  return { ...selection, catalog: defaultCatalog };
}

/** Update the page title from the selection; `defaultCatalog` names a
 *  selection that carries no catalog of its own. */
export function updatePageTitle(selection: Selection | null, defaultCatalog: string) {
  if (typeof document === "undefined") return;
  document.title = pageTitle(selection, defaultCatalog);
}

export function pageTitle(selection: Selection | null, defaultCatalog: string): string {
  const catalog = selection?.catalog ?? defaultCatalog;
  if (!selection || selection.type === "catalog") return `${catalog} - VGI`;
  if (selection.type === "schema") return `${catalog} / ${selection.name} - VGI`;
  if (selection.type === "relationships") {
    const scope = selection.focusTable
      ? `${selection.schema} / ${selection.focusTable}`
      : selection.schema || catalog;
    return `${scope} relationships - VGI`;
  }
  return `${catalog} / ${selection.schema} / ${selection.name} - VGI`;
}

/** Push the selection into the URL hash, creating a history entry, or
 *  (`replace`) updating the current one: browsing the sidebar from the query
 *  editor shouldn't fill Back with entries for a page the reader never saw. */
export function pushSelectionToUrl(selection: Selection | null, { replace = false }: { replace?: boolean } = {}) {
  if (typeof window === "undefined") return;
  const hash = selectionToHash(selection);
  const url = window.location.pathname + window.location.search + hash;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}
