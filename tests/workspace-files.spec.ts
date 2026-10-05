import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { APP_ORIGIN, BASE, T_NORMAL } from "./helpers";

// Workspace files and DuckDB scripts on the welcome page (multi-catalog phase
// 3B; src/lib/workspace/file.ts, duckdb-script.ts). The welcome page attaches
// nothing, so no VGI worker is needed. The logic itself is covered by
// tests/unit/workspace-file.test.ts and workspace-duckdb-script.test.ts; this
// checks the menu, the downloads, the conflict dialog and the notice.

const WORKSPACES = "cupola.workspaces.v1";
const OVERLAY = "cupola.workspaces.local.v1";
const MIGRATED = "cupola.workspaces.migrated.v1";
const SECRETS = "cupola.catalog-secrets.v1";
const WELCOME = `${APP_ORIGIN}${BASE}`;

async function seed(page: Page, entries: Record<string, string>) {
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
  }, entries);
}

function finance(): Record<string, string> {
  const now = Date.now();
  return {
    [MIGRATED]: JSON.stringify({ at: now }),
    [WORKSPACES]: JSON.stringify({
      version: 1,
      workspaces: [{
        id: "ws-fin",
        name: "Finance",
        catalogs: [{ id: "c1", url: "https://a.example/vgi", catalogName: "sales", alias: "sales", options: { region: "eu" } }],
        defaultCatalogId: "c1",
        defaultSchema: "main",
        createdAt: now, updatedAt: now, lastOpenedAt: now,
      }],
    }),
    [OVERLAY]: JSON.stringify({ version: 1, workspaces: { "ws-fin": { catalogs: { c1: { color: 4, enabled: true } } } } }),
    [SECRETS]: JSON.stringify({ "ws-fin:c1:api_key": "s3cret-value" }),
  };
}

const menu = (page: Page) => page.getByTestId("workspace-file-actions");

async function downloadText(page: Page, item: RegExp): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: item }).click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: await readFile(path!, "utf8") };
}

test.describe("workspace files", () => {
  test("export all writes the portable record, without secrets or personal state", async ({ page }) => {
    await seed(page, finance());
    await page.goto(WELCOME);
    await menu(page).click();
    const { name, text } = await downloadText(page, /Export all workspaces/);
    // One workspace: the file is named after it (workspaceFileName).
    expect(name).toBe("finance.cupola-workspaces.json");
    const file = JSON.parse(text);
    expect(file.$schema).toContain("/schema/workspace-v1.json");
    expect(file.format).toBe("cupola-workspaces");
    expect(file.workspaces[0]).toMatchObject({ id: "ws-fin", name: "Finance", catalogs: [{ id: "c1", alias: "sales", options: { region: "eu" }, secrets: ["api_key"] }] });
    expect(text).not.toContain("s3cret-value");
    expect(text).not.toMatch(/"color"|"enabled"/);
  });

  test("export as a DuckDB script reads secrets from the environment", async ({ page }) => {
    await seed(page, finance());
    await page.goto(WELCOME);
    await menu(page).click();
    const { name, text } = await downloadText(page, /Export as DuckDB script/);
    expect(name).toBe("finance.sql");
    expect(text).toContain("INSTALL vgi FROM community; LOAD vgi;");
    expect(text).toContain(`ATTACH 'sales' AS "sales" (TYPE vgi, LOCATION 'https://a.example/vgi', region 'eu', api_key getenv('SALES_API_KEY'));`);
    expect(text).toContain(`USE "sales"."main";`);
    expect(text).not.toContain("s3cret-value");
  });

  test("importing a changed file asks Replace or Keep both", async ({ page }) => {
    await seed(page, finance());
    await page.goto(WELCOME);
    const changed = {
      format: "cupola-workspaces", version: 1,
      workspaces: [{ id: "ws-fin", name: "Finance", catalogs: [{ id: "c1", url: "https://a.example/vgi", catalogName: "sales", alias: "sales", options: { region: "us" }, secrets: ["api_key"] }] }],
    };
    await page.getByTestId("workspace-file-input").setInputFiles({ name: "finance.cupola-workspaces.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(changed)) });
    const dialog = page.getByTestId("workspace-import-conflicts");
    await expect(dialog).toBeVisible({ timeout: T_NORMAL });
    await dialog.getByRole("radio", { name: "Keep both" }).click();
    await dialog.getByRole("button", { name: "Import" }).click();
    const notice = page.getByTestId("workspace-import-notice");
    await expect(notice).toContainText("Imported 1 workspace");
    await expect(notice).toContainText("1 kept as a copy");
    await notice.getByRole("button", { name: "OK" }).click();
    await expect(page.getByTestId("welcome-workspaces")).toContainText("Finance (imported)");
  });

  test("importing a DuckDB script lists the secrets to enter", async ({ page }) => {
    await page.goto(WELCOME);
    const script = [
      "INSTALL vgi FROM community; LOAD vgi;",
      "ATTACH 'sales' AS \"sales\" (TYPE vgi, LOCATION 'https://a.example/vgi', region 'eu', api_key getenv('SALES_API_KEY'));",
      "USE \"sales\".\"main\";",
    ].join("\n");
    await page.getByTestId("workspace-script-input").setInputFiles({ name: "sales.sql", mimeType: "application/sql", buffer: Buffer.from(script) });
    const notice = page.getByTestId("workspace-import-notice");
    await expect(notice).toContainText("Imported 1 workspace", { timeout: T_NORMAL });
    await expect(page.getByTestId("workspace-import-secrets")).toContainText("sales.api_key");
    await expect(page.getByTestId("workspace-import-secrets")).toContainText("SALES_API_KEY");
    // Imported, never opened here (not "Opened Dec 31, 1969").
    await expect(page.getByTestId("welcome-workspace-card")).toContainText("Not opened yet");
    const stored = await page.evaluate((key) => localStorage.getItem(key) ?? "", WORKSPACES);
    expect(stored).toContain('"region":"eu"');
    expect(stored).not.toContain("api_key");
  });

  test("a script with anything but ATTACH and USE is refused, line-numbered", async ({ page }) => {
    await page.goto(WELCOME);
    const script = "ATTACH 'sales' AS s (TYPE vgi, LOCATION 'https://a.example');\nSET threads = 1;";
    await page.getByTestId("workspace-script-input").setInputFiles({ name: "bad.sql", mimeType: "application/sql", buffer: Buffer.from(script) });
    const notice = page.getByTestId("workspace-import-notice");
    await expect(notice).toContainText("Nothing imported", { timeout: T_NORMAL });
    await expect(notice.getByRole("alert")).toContainText("bad.sql: Line 2:");
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), WORKSPACES);
    expect(stored.workspaces ?? []).toEqual([]);
  });
});
