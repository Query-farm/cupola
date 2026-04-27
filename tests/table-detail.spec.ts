/**
 * Table detail page — verifies that comments, tags, descriptions, and example
 * queries render when present in the connected VGI catalog. Each section is a
 * separate test so the report shows exactly which features are exercised.
 *
 * Sections that require specific VGI tags (description_md, example_queries)
 * soft-skip when no table in the catalog carries that tag.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openShell, shellQuery, waitForShellBridge, APP_URL, T_NORMAL } from "./helpers";

interface TableRef { table_schema: string; table_name: string; }

async function listCatalogTables(page: Page): Promise<TableRef[]> {
  const catalogRes = await shellQuery(
    page,
    "SELECT catalog_name FROM information_schema.schemata WHERE catalog_name NOT IN ('memory','system','temp') LIMIT 1",
  );
  expect(catalogRes.ok).toBe(true);
  const catalog = catalogRes.rows![0].catalog_name as string;
  const tablesRes = await shellQuery(
    page,
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_catalog = '${catalog}'
        AND table_schema NOT IN ('information_schema','pg_catalog')
      LIMIT 100`,
  );
  expect(tablesRes.ok).toBe(true);
  return (tablesRes.rows || []) as TableRef[];
}

async function gotoTable(page: Page, t: TableRef): Promise<boolean> {
  const hash = `#/schema/${encodeURIComponent(t.table_schema)}/table/${encodeURIComponent(t.table_name)}`;
  await page.goto(`${APP_URL}${hash}`);
  await page.waitForLoadState("domcontentloaded");
  await waitForShellBridge(page);
  return page
    .getByRole("heading", { name: /Columns/ })
    .first()
    .waitFor({ state: "visible", timeout: T_NORMAL })
    .then(() => true)
    .catch(() => false);
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openShell(page);
});

test.describe("Table detail rendering", () => {
  test("at least one table renders a comment", async ({ page }) => {
    const tables = await listCatalogTables(page);
    let found = false;
    for (const t of tables) {
      if (!(await gotoTable(page, t))) continue;
      const commentP = page.locator("p.text-muted-foreground.mb-3").first();
      if (await commentP.isVisible({ timeout: 200 }).catch(() => false)) {
        const text = ((await commentP.textContent()) || "").trim();
        if (text) { found = true; break; }
      }
    }
    expect(found, "no table in the catalog renders a comment").toBe(true);
  });

  test("at least one table renders the Tags section", async ({ page }) => {
    const tables = await listCatalogTables(page);
    let found = false;
    for (const t of tables) {
      if (!(await gotoTable(page, t))) continue;
      const tagsHeading = page.getByRole("heading", { name: /^Tags$/ });
      if (!(await tagsHeading.isVisible({ timeout: 200 }).catch(() => false))) continue;
      const tagRows = page.locator('h2:has-text("Tags") ~ div table tbody tr');
      if ((await tagRows.count()) > 0) { found = true; break; }
    }
    expect(found, "no table in the catalog renders the Tags section").toBe(true);
  });

  test("at least one table renders an Example Queries section", async ({ page }) => {
    const tables = await listCatalogTables(page);
    let found = false;
    for (const t of tables) {
      if (!(await gotoTable(page, t))) continue;
      if (
        await page
          .getByRole("heading", { name: /Example Quer(y|ies)/i })
          .isVisible({ timeout: 200 })
          .catch(() => false)
      ) {
        found = true;
        break;
      }
    }
    expect(found, "no table in the catalog renders an Example Queries section").toBe(true);
  });

  test("at least one table renders a Description section", async ({ page }) => {
    const tables = await listCatalogTables(page);
    let found = false;
    for (const t of tables) {
      if (!(await gotoTable(page, t))) continue;
      if (
        await page
          .getByRole("button", { name: /^Description$/ })
          .isVisible({ timeout: 200 })
          .catch(() => false)
      ) {
        found = true;
        break;
      }
    }
    if (!found) {
      test.skip(true, "Connected catalog has no table with the vgi.description_md tag.");
    }
  });
});
