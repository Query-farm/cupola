import { test, expect, type Page } from "@playwright/test";
import { APP_ORIGIN, BASE, SERVICE_URL, T_NORMAL, T_SHELL_BOOT, waitForShellBridge } from "./helpers";

// Renaming a catalog alias (docs/multi-catalog.md, phase 3): the dialog counts the references in
// the workspace's reports and editor tabs, rewrites them with a labelled revision, renames the
// alias and re-attaches the catalog under it. Opened here from the ⌘K palette's "Rename catalog …"
// command (the workspace manager calls `onAliasRenameRequested` the same way).
//
//   PORT=9009 ./test-worker/run.sh   (VGI_SERVICE_URL)
const WS = "ws-rename";
const REPORT_KEY = `cupola.evidence.report.v2:${encodeURIComponent(WS)}:${encodeURIComponent("r1")}`;
const HISTORY_KEY = `cupola.evidence.history.v1:${encodeURIComponent(WS)}:${encodeURIComponent("r1")}`;
const TABS_KEY = `vgi-sql-editor-docs::${WS}`;

async function up(url: string): Promise<boolean> {
  try { return (await fetch(url.replace("//localhost", "//127.0.0.1"))).ok; } catch { return false; }
}

async function seed(page: Page) {
  const now = Date.now();
  const entries: Record<string, string> = {
    "cupola.workspaces.migrated.v1": JSON.stringify({ at: now }),
    "cupola.workspaces.v1": JSON.stringify({ version: 1, workspaces: [{
      id: WS, name: "Rename test", defaultCatalogId: "c1", createdAt: now, updatedAt: now, lastOpenedAt: now,
      catalogs: [{ id: "c1", url: SERVICE_URL, catalogName: "cupola_test", alias: "cupola_test", options: {} }],
    }] }),
    "cupola.workspaces.local.v1": JSON.stringify({ version: 1, workspaces: {} }),
    [REPORT_KEY]: JSON.stringify({
      version: 1, id: "r1", title: "Rename me", workspaceId: WS, serviceUrl: SERVICE_URL, createdAt: now, updatedAt: now,
      source: "# Rename me\n\n```sql rows\nSELECT count(*) AS n FROM cupola_test.small.numbers\n```\n\nNot SQL: cupola_test.small.numbers\n",
      setupSql: "", parameters: [], values: {},
    }),
    [TABS_KEY]: JSON.stringify({ version: 1, activeId: "t1", docs: [
      { id: "t1", name: "Query 1", sql: "SELECT * FROM cupola_test.small.numbers -- cupola_test.small.numbers", createdAt: now, updatedAt: now },
      { id: "t2", name: "Query 2", sql: "SELECT 'cupola_test.small.numbers'", createdAt: now, updatedAt: now },
    ] }),
  };
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
  }, entries);
}

const statuses = (page: Page) => page.evaluate(() => (window as any).__bridge?.catalogStatuses?.() ?? []);

async function openRenameDialog(page: Page) {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible({ timeout: T_NORMAL });
  await palette.getByRole("combobox").fill("rename cupola_test");
  await palette.getByRole("option", { name: /Rename catalog cupola_test/ }).click();
  const dialog = page.getByTestId("alias-rename-dialog");
  await expect(dialog).toBeVisible({ timeout: T_NORMAL });
  return dialog;
}

test.describe("alias rename", () => {
  test.beforeEach(async () => {
    test.skip(!(await up(SERVICE_URL)), `start a test worker at ${SERVICE_URL}`);
  });

  test("counts references, rewrites them with a revision, and re-attaches under the new alias", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page);
    await page.goto(`${APP_ORIGIN}${BASE}?local_ws=${WS}`);
    await waitForShellBridge(page);
    await expect.poll(async () => (await statuses(page)).map((s: any) => [s.alias, s.state]), { timeout: T_SHELL_BOOT }).toEqual([["cupola_test", "attached"]]);

    const dialog = await openRenameDialog(page);
    await dialog.getByRole("textbox").fill("renamed");
    // One reference in the report's fence (not its prose), one in the first tab (not its comment,
    // nor the second tab's string literal).
    await expect(dialog.getByTestId("alias-rename-summary")).toContainText("2 references");
    await expect(dialog.getByText("Report: Rename me")).toBeVisible();
    await expect(dialog.getByText("Editor tab: Query 1")).toBeVisible();
    await expect(dialog.getByText("Editor tab: Query 2")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Rename and update 2 references" }).click();
    await expect(dialog).toBeHidden({ timeout: T_NORMAL });

    await expect.poll(async () => (await statuses(page)).map((s: any) => [s.alias, s.state]), { timeout: T_SHELL_BOOT }).toEqual([["renamed", "attached"]]);
    const stored = await page.evaluate(([reportKey, historyKey, tabsKey]) => ({
      report: JSON.parse(localStorage.getItem(reportKey)!),
      history: JSON.parse(localStorage.getItem(historyKey) ?? "null"),
      tabs: JSON.parse(localStorage.getItem(tabsKey)!),
      alias: JSON.parse(localStorage.getItem("cupola.workspaces.v1")!).workspaces[0].catalogs[0].alias,
    }), [REPORT_KEY, HISTORY_KEY, TABS_KEY]);
    expect(stored.alias).toBe("renamed");
    expect(stored.report.source).toContain("FROM renamed.small.numbers");
    expect(stored.report.source).toContain("Not SQL: cupola_test.small.numbers");
    expect(stored.history.revisions.at(-1).label).toBe("Renamed catalog cupola_test → renamed");
    expect(stored.tabs.docs[0].sql).toBe("SELECT * FROM renamed.small.numbers -- cupola_test.small.numbers");
    expect(stored.tabs.docs[1].sql).toBe("SELECT 'cupola_test.small.numbers'");
  });

  test("Rename only leaves the references as they were", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page);
    await page.goto(`${APP_ORIGIN}${BASE}?local_ws=${WS}`);
    await waitForShellBridge(page);
    const dialog = await openRenameDialog(page);
    await dialog.getByRole("textbox").fill("only_alias");
    await dialog.getByRole("button", { name: "Rename only" }).click();
    await expect(dialog).toBeHidden({ timeout: T_NORMAL });
    const source = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).source, REPORT_KEY);
    expect(source).toContain("FROM cupola_test.small.numbers");
  });

  test("an invalid or taken alias is refused", async ({ page }) => {
    await seed(page);
    await page.goto(`${APP_ORIGIN}${BASE}?local_ws=${WS}`);
    await waitForShellBridge(page);
    const dialog = await openRenameDialog(page);
    await dialog.getByRole("textbox").fill("memory");
    await expect(dialog.getByText(/reserved/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Rename/ }).first()).toBeDisabled();
  });
});
