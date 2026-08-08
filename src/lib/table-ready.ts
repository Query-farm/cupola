import { engine, onQueryChange } from "@/lib/shell-bridge";

/**
 * Wait until DuckDB can serve the given tablePath:
 *   - engine.query must be live (worker booted)
 *   - unless the table is provably NOT in the primary VGI catalog, ATTACH + USE
 *     must have completed (engine.attached resolved). Tables we can prove live
 *     in memory or a secondary-attached catalog only need engine.query.
 *
 * Without the attached gate, a click on a VGI-catalog table immediately after
 * page load fires a query against an unattached DB and caches the resulting
 * ORDER BY ALL fallback as the wrong choice for the table's lifetime.
 *
 * Subtlety that caused a real bug: `engine.query` goes live at the *eager worker
 * boot* (CatalogApp mount), but `engine.catalogName` is only set later by
 * `initShell` when the lazy DuckDBShell mounts. So a *null* `catalogName` means
 * "the shell hasn't initialized yet — we can't tell which catalog this is", NOT
 * "this is a memory table". Treating null as "skip the wait" let a quick Preview
 * click query the un-attached catalog and show no rows until the user toggled to
 * the SQL shell (which completes ATTACH) and back. So we only skip the gate when
 * we can *prove* the table is in a non-primary catalog. `engine.attached` always
 * resolves — markAttached fires on attach success, attach failure, and the
 * no-catalog-configured case — so awaiting it here can never hang.
 */
export function waitForTableReady(tablePath: string): Promise<void> {
  const firstSegment = tablePath.split(".")[0];
  const provablyNonPrimary = !!engine.catalogName && firstSegment !== engine.catalogName;
  const queryReady: Promise<void> = engine.query
    ? Promise.resolve()
    : new Promise((resolve) => {
        const unsubscribe = onQueryChange(() => {
          if (engine.query) { unsubscribe(); resolve(); }
        });
      });
  return provablyNonPrimary
    ? queryReady
    : Promise.all([queryReady, engine.attached ?? Promise.resolve()]).then(() => {});
}
