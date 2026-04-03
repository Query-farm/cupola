/**
 * URL hash routing and page title management.
 *
 * Encodes the current selection into the URL hash so users can share links.
 * Format: #/schema/property/table/parcels
 */

import type { Selection } from "./tree";

/** Encode a Selection into a URL hash string. */
export function selectionToHash(selection: Selection | null): string {
  if (!selection || selection.type === "catalog") return "";
  const e = encodeURIComponent;
  if (selection.type === "schema") return `#/schema/${e(selection.name)}`;
  return `#/schema/${e(selection.schema!)}/${selection.type}/${e(selection.name)}`;
}

/** Decode a URL hash string into a Selection, or null for root. */
export function hashToSelection(hash: string): Selection | null {
  if (!hash || hash === "#" || hash === "#/") return null;
  const path = hash.replace(/^#\/?/, "");
  const parts = path.split("/").map(decodeURIComponent);

  // #/schema/{name}
  if (parts[0] === "schema" && parts.length === 2) {
    return { type: "schema", name: parts[1], schema: parts[1] };
  }

  // #/schema/{schema}/table/{name}
  // #/schema/{schema}/view/{name}
  // #/schema/{schema}/function/{name}
  if (parts[0] === "schema" && parts.length === 4) {
    const schema = parts[1];
    const type = parts[2] as "table" | "view" | "function" | "macro";
    const name = parts[3];
    if (["table", "view", "function", "macro"].includes(type)) {
      return { type, name, schema };
    }
  }

  return null;
}

/** Update the page title based on current selection and catalog name. */
export function updatePageTitle(selection: Selection | null, catalogName: string) {
  if (typeof document === "undefined") return;
  if (!selection || selection.type === "catalog") {
    document.title = `${catalogName} - VGI`;
    return;
  }
  if (selection.type === "schema") {
    document.title = `${catalogName} / ${selection.name} - VGI`;
    return;
  }
  document.title = `${catalogName} / ${selection.schema} / ${selection.name} - VGI`;
}

/** Push the selection into the URL hash, creating a history entry. */
export function pushSelectionToUrl(selection: Selection | null) {
  if (typeof window === "undefined") return;
  const hash = selectionToHash(selection);
  const url = window.location.pathname + window.location.search + hash;
  window.history.pushState(null, "", url);
}
