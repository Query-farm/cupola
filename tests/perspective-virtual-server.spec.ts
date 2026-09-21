/**
 * Perspective VIRTUAL SERVER path — selecting a table and opening the
 * Perspective tab mounts a <perspective-viewer> backed by VgiDuckDBHandler,
 * which compiles pivots to SQL against DuckDB-WASM.
 *
 * This is deliberately separate from perspective.spec.ts, which drives
 * `bridge.showPerspective` — a completely different code path that loads a
 * static Arrow snapshot via `perspectiveWorker.table()`. The two share a DOM
 * container and a module-global worker but nothing else, and only the static
 * one had coverage. The gap was not academic: the virtual-server path was the
 * one that broke on the Perspective v5 upgrade with "Missing
 * perspective-client.wasm" — which is a red herring. That error means
 * <perspective-viewer> never registered, which happens when
 * viewer/dist/wasm/perspective-viewer.wasm fails to load (`init_client`
 * swallows the failure, so the import still resolves). The customElements
 * assertion below is the real regression guard for that.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  APP_URL,
  T_NORMAL,
  T_SHELL_BOOT,
  gotoApp,
  waitForShellBridge,
  shellQuery,
} from "./helpers";

interface TableRef {
  catalog: string;
  table_schema: string;
  table_name: string;
}

/** Find a table in the ATTACHed VGI catalog (not memory/system) that the
 *  grouping test can pivot: it needs a string column with at least one value.
 *  "Whatever table comes first" is not that — it picked an empty table, an
 *  all-NULL one, and an integer-only one depending on the catalog. Candidates
 *  are probed with LIMIT 1, which stays cheap however large the table is. */
async function findTable(page: Page): Promise<TableRef | null> {
  const catalogRes = await shellQuery(
    page,
    `SELECT catalog_name FROM information_schema.schemata
      WHERE catalog_name NOT IN ('memory', 'system', 'temp') LIMIT 1`,
  );
  const catalog = catalogRes.rows?.[0]?.catalog_name as string | undefined;
  if (!catalog) return null;

  const res = await shellQuery(
    page,
    `SELECT table_schema, table_name, min(column_name) AS column_name
       FROM information_schema.columns
      WHERE table_catalog = '${catalog}'
        AND table_schema NOT IN ('information_schema', 'pg_catalog')
        AND data_type = 'VARCHAR'
      GROUP BY ALL ORDER BY table_schema, table_name LIMIT 8`,
  );
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  for (const row of res.rows ?? []) {
    const path = [catalog, row.table_schema, row.table_name].map(quote).join(".");
    const probe = await shellQuery(page, `SELECT 1 FROM ${path} WHERE ${quote(row.column_name)} IS NOT NULL LIMIT 1`);
    if (probe.rows?.length) return { catalog, table_schema: row.table_schema, table_name: row.table_name };
  }
  return null;
}

test.describe("Perspective virtual server", () => {
  test("selecting a table mounts a DuckDB-backed <perspective-viewer>", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await gotoApp(page);
    await waitForShellBridge(page);

    const target = await findTable(page);
    test.skip(!target, "no table in the attached catalog to pivot");

    const hash = `#/schema/${encodeURIComponent(target!.table_schema)}/table/${encodeURIComponent(target!.table_name)}`;
    await page.goto(`${APP_URL}${hash}`);
    await waitForShellBridge(page);

    await page.getByTestId("tab-perspective").click();
    await expect(page.getByTestId("tab-perspective")).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: T_NORMAL },
    );

    // The viewer element must actually register. `worker()` reads the client
    // wasm off this class, so a missing registration is what produced the
    // "Missing perspective-client.wasm" failure.
    await page.waitForFunction(
      () => !!customElements.get("perspective-viewer"),
      null,
      { timeout: T_SHELL_BOOT },
    );

    await expect(page.locator("perspective-viewer")).toBeAttached({
      timeout: T_SHELL_BOOT,
    });

    // The virtual server is live only if the viewer can resolve a schema for
    // the hosted table — that round-trips tableSchema() through the handler
    // and out to DuckDB.
    const cols = await page.evaluate(async () => {
      const el = document.querySelector("perspective-viewer") as any;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const t = await el?.getTable?.();
          if (t) return (await t.columns()) as string[];
        } catch {
          /* not ready yet */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    });
    expect(cols, "virtual server never produced a table schema").not.toBeNull();
    expect(cols!.length).toBeGreaterThan(0);

    // Perspective shows the table's real column names. The handler used to
    // rename every `_` to `-` (a workaround for a Perspective bug fixed in
    // 5.0), so `order_id` appeared as `order-id`.
    const real = await shellQuery(
      page,
      `SELECT column_name FROM information_schema.columns
        WHERE table_catalog = '${target!.catalog}' AND table_schema = '${target!.table_schema}' AND table_name = '${target!.table_name}'`,
    );
    const realNames = new Set((real.rows ?? []).map((row) => String(row.column_name)));
    expect(cols!.filter((name) => !realNames.has(name)), "Perspective columns that are not real column names").toEqual([]);

    expect(
      errors.filter((e) => /Missing perspective-client\.wasm|virtual server error/i.test(e)),
    ).toEqual([]);
  });

  test("grouping pivots through DuckDB and supports collapse/expand", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await gotoApp(page);
    await waitForShellBridge(page);

    const target = await findTable(page);
    test.skip(!target, "no table in the attached catalog to pivot");

    const hash = `#/schema/${encodeURIComponent(target!.table_schema)}/table/${encodeURIComponent(target!.table_name)}`;
    await page.goto(`${APP_URL}${hash}`);
    await waitForShellBridge(page);
    await page.getByTestId("tab-perspective").click();
    await expect(page.locator("perspective-viewer")).toBeAttached({
      timeout: T_SHELL_BOOT,
    });

    // Group by the first string column. This exercises the grouped branch of
    // tableMakeView (GROUP BY ROLLUP + __GROUPING_ID__), which is where
    // ViewTraversal is built — a fork-only extension to the handler trait
    // (view_collapse / view_expand) that upstream does not have.
    const result = await page.evaluate(async () => {
      const el = document.querySelector("perspective-viewer") as any;
      const deadline = Date.now() + 20_000;
      let table: any = null;
      while (Date.now() < deadline && !table) {
        try {
          table = await el.getTable();
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!table) return { err: "no table" };

      const schema: Record<string, string> = await table.schema();
      const groupCol = Object.keys(schema).find((k) => schema[k] === "string");
      if (!groupCol) return { err: "no string column to group by", schema };

      await el.restore({ group_by: [groupCol], columns: [groupCol] });

      const view = await el.getView();
      const expanded = await view.num_rows();
      // collapse(0) folds the root; the traversal should hide its descendants.
      const removed = await view.collapse(0);
      const afterCollapse = await view.num_rows();
      const added = await view.expand(0);
      const afterExpand = await view.num_rows();

      return { groupCol, expanded, removed, afterCollapse, added, afterExpand };
    });

    expect(result.err, `pivot failed: ${result.err} ${JSON.stringify(result.schema ?? "")}`).toBeUndefined();
    // A rollup always yields at least the total row.
    expect(result.expanded).toBeGreaterThan(0);
    // Collapsing the root must actually shrink the visible set, and expanding
    // must restore it — that round-trip is the whole point of ViewTraversal.
    expect(result.afterCollapse).toBeLessThan(result.expanded!);
    expect(result.afterExpand).toBe(result.expanded);

    expect(
      errors.filter((e) => /virtual server error|Missing perspective-client\.wasm/i.test(e)),
    ).toEqual([]);
  });
});
