import { useSyncExternalStore } from 'react';
import { catalogInventory } from './catalog-store';
import type { CatalogSnapshot } from './catalog-inventory';

/** Subscribe to the inventory, or to one part of it. A component re-renders
 *  only when what `select` returns changes (by identity), so pick a field
 *  rather than the whole snapshot: `refreshing` alone flips twice a refresh. */
export function useCatalogInventory(): CatalogSnapshot;
export function useCatalogInventory<T>(select: (snapshot: CatalogSnapshot) => T): T;
export function useCatalogInventory<T>(select?: (snapshot: CatalogSnapshot) => T) {
  const read = () => select ? select(catalogInventory.getSnapshot()) : catalogInventory.getSnapshot();
  return useSyncExternalStore(catalogInventory.subscribe, read, read);
}
