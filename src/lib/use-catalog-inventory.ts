import { useSyncExternalStore } from 'react';
import { catalogInventory } from './catalog-store';
export function useCatalogInventory() {
  return useSyncExternalStore(catalogInventory.subscribe, catalogInventory.getSnapshot, catalogInventory.getSnapshot);
}
