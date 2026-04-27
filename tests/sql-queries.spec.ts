/**
 * SQL query execution — direct bridge.query results and error surfacing.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, shellQuery, waitForShellBridge } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

test.describe("SQL queries", () => {
  test("runs a basic literal query", async ({ page }) => {
    const result = await shellQuery(page, "SELECT 1 + 1 AS two");
    expect(result.ok).toBe(true);
    expect(result.numRows).toBe(1);
    expect(result.rows![0].two).toBe(2);
  });

  test("queries the attached VGI catalog", async ({ page }) => {
    const result = await shellQuery(
      page,
      "SELECT catalog_name FROM information_schema.schemata WHERE catalog_name NOT IN ('memory','system','temp') LIMIT 1",
    );
    expect(result.ok).toBe(true);
    expect(result.numRows).toBeGreaterThan(0);
    expect(typeof result.rows![0].catalog_name).toBe("string");
  });

  test("returns an error for invalid SQL", async ({ page }) => {
    const result = await shellQuery(page, "SELEKT bogus");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
