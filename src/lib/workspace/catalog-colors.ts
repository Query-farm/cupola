/**
 * The active workspace's chip colour per alias, for surfaces far from the
 * workspace (the breadcrumb). CatalogApp publishes it; anything not in it
 * (`memory`, a database attached by hand) has no chip.
 */
import { useSyncExternalStore } from "react";

let colors: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

export function setCatalogColors(next: ReadonlyMap<string, number>): void {
  if (next.size === colors.size && [...next].every(([alias, color]) => colors.get(alias) === color)) return;
  colors = next;
  for (const listener of listeners) listener();
}

export function catalogColor(alias: string): number | undefined {
  return colors.get(alias);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCatalogColor(alias: string): number | undefined {
  return useSyncExternalStore(subscribe, () => colors.get(alias), () => undefined);
}
