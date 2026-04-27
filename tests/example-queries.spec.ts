/**
 * Example queries — every example query rendered on schema and table detail
 * pages should execute successfully against the attached VGI catalog.
 *
 * For each schema (and a sample of tables within it), we navigate to the
 * detail page, expand the "Example Queries" accordion if present, click each
 * "Run" button (covering the UI handler), and independently re-run the SQL
 * via bridge.query to assert the result is ok with no error.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openShell, shellQuery, waitForShellBridge, APP_URL, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openShell(page);
});

/** Find the catalog name attached from the VGI server. */
async function getCatalogName(page: Page): Promise<string> {
  const r = await shellQuery(
    page,
    "SELECT catalog_name FROM information_schema.schemata WHERE catalog_name NOT IN ('memory','system','temp') LIMIT 1",
  );
  expect(r.ok).toBe(true);
  expect(r.numRows).toBeGreaterThan(0);
  return r.rows![0].catalog_name as string;
}

/** Expand all example-query accordion triggers and return the rendered SQL strings. */
async function extractExampleSqls(page: Page): Promise<string[]> {
  const heading = page.getByRole("heading", { name: /Example Quer(y|ies)/i });
  if (!(await heading.isVisible({ timeout: 1500 }).catch(() => false))) return [];

  // Click each accordion trigger to expand it (Run button only renders when expanded).
  const triggers = page.locator('button[data-state="closed"]', {
    has: page.locator("svg"), // chevron
  });
  // Find example-query accordion triggers by being siblings of QueryBlock content.
  // Simpler: select all triggers within the Accordion.Root that holds example queries.
  // The Accordion.Root has <h2>Example Quer{y,ies}</h2> immediately preceding it.
  const accordionTriggers = page.locator('h2:has-text("Example Quer") ~ * button[data-state]');
  const count = await accordionTriggers.count();
  for (let i = 0; i < count; i++) {
    const trig = accordionTriggers.nth(i);
    const state = await trig.getAttribute("data-state");
    if (state === "closed") await trig.click();
  }

  // Read the SQL out of every <pre><code> rendered under the example queries section.
  const sqls: string[] = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll("h2"));
    const h = headings.find((el) => /Example Quer(y|ies)/i.test(el.textContent || ""));
    if (!h) return [];
    // Walk the next sibling (the Accordion.Root) and collect all <pre><code> text.
    const root = h.nextElementSibling as HTMLElement | null;
    if (!root) return [];
    const codes = Array.from(root.querySelectorAll("pre code"));
    return codes.map((c) => (c.textContent || "").trim()).filter(Boolean);
  });
  return sqls;
}

/** Click every visible "Run" button under the example queries section. */
async function clickAllRunButtons(page: Page): Promise<number> {
  const heading = page.getByRole("heading", { name: /Example Quer(y|ies)/i });
  if (!(await heading.isVisible({ timeout: 500 }).catch(() => false))) return 0;
  const runButtons = page.locator('h2:has-text("Example Quer") ~ * button:has-text("Run")');
  const n = await runButtons.count();
  for (let i = 0; i < n; i++) {
    await runButtons.nth(i).click();
  }
  return n;
}

test.describe("Example queries", () => {
  test("schema-page example queries execute successfully", async ({ page }) => {
    const catalog = await getCatalogName(page);
    const schemasRes = await shellQuery(
      page,
      `SELECT schema_name FROM information_schema.schemata WHERE catalog_name = '${catalog}' AND schema_name NOT IN ('information_schema','pg_catalog')`,
    );
    expect(schemasRes.ok).toBe(true);
    const schemas = (schemasRes.rows || []).map((r) => r.schema_name as string);
    expect(schemas.length).toBeGreaterThan(0);

    let totalRun = 0;
    let totalChecked = 0;
    for (const schema of schemas) {
      await page.goto(`${APP_URL}#/schema/${encodeURIComponent(schema)}`);
      // Allow the detail panel to render.
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(150);

      const sqls = await extractExampleSqls(page);
      if (sqls.length === 0) continue;

      // Click every Run button — exercises the bridge.runQuery UI path.
      await clickAllRunButtons(page);

      for (const sql of sqls) {
        const r = await shellQuery(page, sql);
        expect(r.ok, `schema=${schema} sql=${sql.slice(0, 80)}\nerror: ${r.error}`).toBe(true);
        totalChecked++;
      }
      totalRun += sqls.length;
    }

    if (totalChecked === 0) {
      test.skip(true, "Connected catalog has no schema-level example queries (vgi.example_queries tag).");
    }
    console.log(`Schema example queries: ran ${totalRun}, asserted ${totalChecked}`);
  });

  test("table-page example queries execute successfully", async ({ page }) => {
    const catalog = await getCatalogName(page);
    // Pick up to a few tables per schema to keep the suite quick.
    const tablesRes = await shellQuery(
      page,
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_catalog = '${catalog}'
          AND table_schema NOT IN ('information_schema','pg_catalog')
        LIMIT 50`,
    );
    expect(tablesRes.ok).toBe(true);
    const tables = (tablesRes.rows || []) as Array<{ table_schema: string; table_name: string }>;
    expect(tables.length).toBeGreaterThan(0);

    let totalRun = 0;
    let totalChecked = 0;
    for (const t of tables) {
      const hash = `#/schema/${encodeURIComponent(t.table_schema)}/table/${encodeURIComponent(t.table_name)}`;
      await page.goto(`${APP_URL}${hash}`);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(150);

      const sqls = await extractExampleSqls(page);
      if (sqls.length === 0) continue;

      await clickAllRunButtons(page);

      for (const sql of sqls) {
        const r = await shellQuery(page, sql);
        expect(
          r.ok,
          `${t.table_schema}.${t.table_name} sql=${sql.slice(0, 80)}\nerror: ${r.error}`,
        ).toBe(true);
        totalChecked++;
      }
      totalRun += sqls.length;
      // Stop once we've validated a handful so the test stays fast.
      if (totalChecked >= 5) break;
    }

    expect(
      totalChecked,
      "no table-level example queries found in the connected catalog",
    ).toBeGreaterThan(0);
    console.log(`Table example queries: ran ${totalRun}, asserted ${totalChecked}`);
  });
});
