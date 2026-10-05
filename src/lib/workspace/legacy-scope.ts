/**
 * Read-only fallback from a workspace to the service URL its data used to be
 * keyed by.
 *
 * Before workspaces, editor tabs, query history and Evidence reports were
 * keyed by the default catalog's service URL. The boot migration
 * (`migrate.ts`) copies them under the workspace id; this covers what it
 * could not see: data written under the URL after it ran (another tab still
 * on an older release, a test seeding storage) and anything a full storage
 * kept it from copying. The stores read `<workspace id>` first and fall back
 * to `<service URL>`; they only ever write the workspace key, and never
 * delete the old one (except when the reader deletes that item).
 *
 * The app registers the active workspace's legacy URL once at boot.
 */
const fallbacks = new Map<string, string>();

export function setLegacyScope(scope: string, legacyServiceUrl: string | null | undefined): void {
  if (legacyServiceUrl) fallbacks.set(scope, legacyServiceUrl);
  else fallbacks.delete(scope);
}

/** The service URL whose old keys `scope` reads as a fallback, if any. */
export function legacyScopeFor(scope: string): string | undefined {
  return fallbacks.get(scope);
}

export function clearLegacyScopes(): void {
  fallbacks.clear();
}
