import { test, expect, type Page } from "@playwright/test";
import { APP_ORIGIN, BASE, SERVICE_URL, T_NORMAL, T_SHELL_BOOT, openEditor, shellQuery, waitForShellBridge } from "./helpers";

// Persistent workspaces (docs/multi-catalog.md, phase 2): the store, the boot
// migration, the picker, and the server-redirect rules. Needs two plain test
// workers, plus the attach-options variant for the options test:
//
//   PORT=9009 ./test-worker/run.sh                               (VGI_SERVICE_URL)
//   PORT=9011 ./test-worker/run.sh                               (VGI_SECOND_SERVICE_URL)
//   CUPOLA_TEST_ATTACH_OPTIONS=1 PORT=9010 ./test-worker/run.sh  (VGI_OPTIONS_SERVICE_URL)
const SECOND_URL = process.env.VGI_SECOND_SERVICE_URL || "http://localhost:9011";
const OPTIONS_URL = process.env.VGI_OPTIONS_SERVICE_URL || "http://localhost:9010";

const WORKSPACES = "cupola.workspaces.v1";
const OVERLAY = "cupola.workspaces.local.v1";
const MIGRATED = "cupola.workspaces.migrated.v1";
const SECRETS = "cupola.catalog-secrets.v1";

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url.replace("//localhost", "//127.0.0.1"), { method: "GET" })).ok;
  } catch {
    return false;
  }
}

const serviceUrl = (service: string) => `${APP_ORIGIN}${BASE}?service=${encodeURIComponent(service)}`;
const workspaceUrl = (id: string, path = "") => `${APP_ORIGIN}${BASE}${path}?local_ws=${encodeURIComponent(id)}`;
const statuses = (page: Page) => page.evaluate(() => (window as any).__bridge?.catalogStatuses?.() ?? []);
const picker = (page: Page) => page.getByTestId("workspace-picker");
const panel = (page: Page) => page.getByTestId("workspace-picker-panel");

async function allSettled(page: Page, expected: Record<string, string>) {
  await waitForShellBridge(page);
  await expect.poll(async () => Object.fromEntries((await statuses(page)).map((s: any) => [s.alias, s.state])), { timeout: T_SHELL_BOOT })
    .toEqual(expected);
}

interface SeedCatalog { id: string; url: string; catalogName: string; alias: string; options?: Record<string, string> }
interface SeedWorkspace { id: string; name: string | null; catalogs: SeedCatalog[]; defaultCatalogId?: string }

/** Write storage once per test (a reload must not re-seed). */
async function seed(page: Page, entries: Record<string, string>) {
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
  }, entries);
}

function workspaceStore(workspaces: SeedWorkspace[], overlay: Record<string, unknown> = {}): Record<string, string> {
  const now = Date.now();
  return {
    [MIGRATED]: JSON.stringify({ at: now }),
    [WORKSPACES]: JSON.stringify({
      version: 1,
      workspaces: workspaces.map((w, i) => ({
        ...w,
        catalogs: w.catalogs.map((c) => ({ options: {}, ...c })),
        defaultCatalogId: w.defaultCatalogId ?? w.catalogs[0]?.id ?? null,
        createdAt: now, updatedAt: now, lastOpenedAt: now - i,
      })),
    }),
    [OVERLAY]: JSON.stringify({ version: 1, workspaces: overlay }),
  };
}

const TWO: SeedWorkspace = {
  id: "ws-two",
  name: "Two catalogs",
  catalogs: [
    { id: "first", url: SERVICE_URL, catalogName: "cupola_test", alias: "cupola_test" },
    { id: "second", url: SECOND_URL, catalogName: "cupola_test", alias: "second" },
  ],
};

test.describe("workspaces", () => {
  test.beforeEach(async () => {
    test.skip(!(await up(SERVICE_URL)) || !(await up(SECOND_URL)), `start test workers at ${SERVICE_URL} and ${SECOND_URL}`);
  });

  test("a workspace persists across a reload, renamed from the picker", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(serviceUrl(SERVICE_URL));
    await allSettled(page, { cupola_test: "attached" });
    await picker(page).click();
    await panel(page).getByTestId("workspace-rename").click();
    await panel(page).getByTestId("workspace-name-input").fill("My analysis");
    await panel(page).getByRole("button", { name: "Save" }).click();
    // A named workspace is opened by id from now on, not by the service.
    await expect(page).toHaveURL(/local_ws=/);
    expect(new URL(page.url()).searchParams.get("service")).toBeNull();
    await page.reload();
    await allSettled(page, { cupola_test: "attached" });
    await expect(picker(page)).toContainText("My analysis");
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), WORKSPACES);
    expect(stored.workspaces.map((w: any) => w.name)).toContain("My analysis");
  });

  test("legacy storage is migrated: recents, history, editor tabs, a report and a secret show up under the workspace", async ({ page }) => {
    // The secret is cupola_secure's required api_key: the catalog attaches only if it was migrated.
    test.skip(!(await up(OPTIONS_URL)), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(120_000);
    const enc = encodeURIComponent;
    const report = { version: 1, id: "legacy-report", title: "Legacy workspace report", serviceUrl: OPTIONS_URL, source: "# Legacy workspace report", setupSql: "", parameters: [], values: {}, createdAt: 1, updatedAt: 1 };
    await seed(page, {
      "vgi-recent-services": JSON.stringify([{ url: OPTIONS_URL, catalogName: "cupola_secure", lastUsed: new Date().toISOString() }]),
      [`cupola.query-history.v1::${OPTIONS_URL}`]: JSON.stringify([{ id: 1, timestamp: Date.now(), sql: "SELECT 'from the old history'", executionTimeMs: 1, success: true, source: "editor" }]),
      [`vgi-sql-editor-docs::${OPTIONS_URL}`]: JSON.stringify({ version: 1, docs: [{ id: "d1", name: "Old tab", sql: "SELECT 'old editor tab'", createdAt: 1, updatedAt: 1 }], activeId: "d1" }),
      [`cupola.evidence.report.v2:${enc(OPTIONS_URL)}:legacy-report`]: JSON.stringify(report),
      [SECRETS]: JSON.stringify({ [JSON.stringify([OPTIONS_URL, "cupola_secure", "api_key"])]: "legacy-secret-1" }),
    });
    await page.goto(serviceUrl(OPTIONS_URL));
    await allSettled(page, { cupola_secure: "attached" });

    const storage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!])));
    expect(storage["cupola.workspaces.migrated.v1"]).toBeTruthy();
    const ws = JSON.parse(storage["cupola.workspaces.v1"]).workspaces;
    expect(ws).toHaveLength(1);
    const id = ws[0].id;
    expect(ws[0].catalogs[0].alias).toBe("cupola_secure");
    expect(storage[`cupola.query-history.v1::${id}`]).toContain("from the old history");
    expect(storage[`vgi-sql-editor-docs::${id}`]).toContain("old editor tab");
    expect(storage[`cupola.evidence.report.v2:${enc(id)}:legacy-report`]).toContain(id);
    expect(storage[SECRETS]).toContain(`${id}:${ws[0].catalogs[0].id}:api_key`);
    expect(storage["cupola.workspaces.v1"]).not.toContain("legacy-secret-1");
    // Old keys are kept.
    expect(storage[`cupola.query-history.v1::${OPTIONS_URL}`]).toBeTruthy();

    await openEditor(page);
    await expect(page.locator(".cm-content").first()).toContainText("old editor tab");
    await page.getByTestId("editor-history").click();
    await page.getByTestId("editor-history-view-all").click();
    await expect(page.getByTestId("editor-history-panel")).toContainText("from the old history");
    await expect(page.getByTestId("catalog-sidebar")).toContainText("Legacy workspace report");
  });

  test("a ?service= redirect while a named workspace holds it shows a banner and changes nothing", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page, workspaceStore([TWO]));
    await page.goto(serviceUrl(SERVICE_URL));
    const banner = page.getByTestId("service-redirect-banner");
    await expect(banner).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(banner.getByRole("link", { name: "Open “Two catalogs” instead" })).toBeVisible();
    await allSettled(page, { cupola_test: "attached" });
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), WORKSPACES);
    const named = stored.workspaces.find((w: any) => w.id === "ws-two");
    expect(named.name).toBe("Two catalogs");
    expect(named.catalogs.map((c: any) => c.id)).toEqual(["first", "second"]);
    // The redirect got its own untitled workspace.
    expect(stored.workspaces.filter((w: any) => w.name === null)).toHaveLength(1);
    await banner.getByRole("link", { name: "Open “Two catalogs” instead" }).click();
    await expect(page).toHaveURL(/local_ws=ws-two/);
    await allSettled(page, { cupola_test: "attached", second: "attached" });
  });

  test("a redirect for a service no named workspace has offers Add to the last named one", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page, workspaceStore([{ id: "ws-one", name: "Only second", catalogs: [TWO.catalogs[1]] }]));
    await page.goto(serviceUrl(SERVICE_URL));
    const banner = page.getByTestId("service-redirect-banner");
    await expect(banner.getByRole("button", { name: "Add to “Only second”" })).toBeVisible({ timeout: T_SHELL_BOOT });
    const unchanged = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).workspaces.find((w: any) => w.id === "ws-one").catalogs.length, WORKSPACES);
    expect(unchanged).toBe(1);
  });

  test("Attach a catalog… adds one into the running workspace, and Detach has an undo", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(serviceUrl(SERVICE_URL));
    await allSettled(page, { cupola_test: "attached" });
    await picker(page).click();
    await panel(page).getByTestId("attach-catalog-open").click();
    const form = panel(page).getByTestId("attach-catalog-form");
    await form.getByTestId("attach-catalog-url").fill(SECOND_URL);
    await form.getByTestId("attach-catalog-test").click();
    await expect(form.getByTestId("attach-catalog-test-result")).toContainText("Reachable: 1 catalog");
    // The server's name is taken: the alias is prefilled clear of it, and validated.
    await expect(form.getByTestId("attach-catalog-alias")).toHaveValue("cupola_test_2");
    await form.getByTestId("attach-catalog-alias").fill("memory");
    await expect(form).toContainText("reserved");
    await form.getByTestId("attach-catalog-alias").fill("other");
    await form.getByTestId("attach-catalog-submit").click();
    // No reload: the engine that was already running attaches it.
    await allSettled(page, { cupola_test: "attached", other: "attached" });
    expect((await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM other.small.regions")).rows?.[0]?.n).toBe(8);
    await expect(page).toHaveURL(/local_ws=/);

    // The picker stays open after attaching, listing the new catalog with its status.
    await expect(panel(page)).toBeVisible();
    const row = panel(page).locator('[data-testid="picker-catalog-row"][data-alias="other"]');
    await expect(row).toHaveAttribute("data-state", "attached");
    await row.hover();
    await row.getByTestId("picker-catalog-more").click();
    await row.getByRole("menuitem", { name: "Detach" }).click();
    await expect.poll(async () => (await statuses(page)).map((s: any) => s.alias)).toEqual(["cupola_test"]);
    expect((await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM duckdb_databases() WHERE database_name = 'other'")).rows?.[0]?.n).toBe(0);
    // Activated from the keyboard: in dev, Astro's toolbar sits over the bottom-centred toast.
    const undo = page.getByTestId("undo-toast").getByRole("button", { name: "Undo" });
    await undo.focus();
    await page.keyboard.press("Enter");
    await allSettled(page, { cupola_test: "attached", other: "attached" });
  });

  test("Make default moves USE", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page, workspaceStore([TWO]));
    await page.goto(workspaceUrl("ws-two"));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    expect((await shellQuery(page, "SELECT current_database() AS db")).rows?.[0]?.db).toBe("cupola_test");
    await picker(page).click();
    const row = panel(page).locator('[data-testid="picker-catalog-row"][data-alias="second"]');
    await row.hover();
    await row.getByTestId("picker-catalog-more").click();
    await row.getByRole("menuitem", { name: "Make default" }).click();
    await expect.poll(async () => (await shellQuery(page, "SELECT current_database() AS db")).rows?.[0]?.db, { timeout: T_NORMAL }).toBe("second");
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).workspaces[0].defaultCatalogId, WORKSPACES);
    expect(stored).toBe("second");
  });

  test("Edit options on one catalog of two re-attaches only that one", async ({ page }) => {
    test.skip(!(await up(OPTIONS_URL)), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(120_000);
    await seed(page, workspaceStore([{ id: "ws-opts", name: "With options", catalogs: [
      TWO.catalogs[0],
      { id: "secure", url: OPTIONS_URL, catalogName: "cupola_secure", alias: "cupola_secure" },
    ] }]));
    await page.goto(workspaceUrl("ws-opts"));
    // cupola_secure requires api_key, which nothing has given it yet.
    await allSettled(page, { cupola_test: "attached", cupola_secure: "failed" });
    await picker(page).click();
    const row = panel(page).locator('[data-testid="picker-catalog-row"][data-alias="cupola_secure"]');
    await row.hover();
    await row.getByTestId("picker-catalog-more").click();
    await row.getByRole("menuitem", { name: "Edit options…" }).click();
    const dialog = page.getByTestId("catalog-options-dialog");
    await dialog.locator('input[id$="-api_key"]').fill("edit-options-secret");
    await dialog.getByTestId("catalog-options-save").click();
    await allSettled(page, { cupola_test: "attached", cupola_secure: "attached" });
    expect((await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM cupola_secure.small.regions")).rows?.[0]?.n).toBe(8);
    const stored = await page.evaluate(([w, s]) => ({ ws: localStorage.getItem(w)!, secrets: localStorage.getItem(s)! }), [WORKSPACES, SECRETS]);
    expect(stored.ws).not.toContain("edit-options-secret");
    expect(stored.secrets).toContain("ws-opts:secure:api_key");
  });

  test("a disabled catalog is kept, listed, and not attached", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page, workspaceStore([TWO], { "ws-two": { catalogs: { second: { enabled: false } } } }));
    await page.goto(workspaceUrl("ws-two"));
    await allSettled(page, { cupola_test: "attached", second: "disabled" });
    expect((await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM duckdb_databases() WHERE database_name = 'second'")).rows?.[0]?.n).toBe(0);
    const root = page.getByTestId("catalog-sidebar").locator('[data-testid="catalog-status-root"][data-alias="second"]');
    await expect(root).toHaveAttribute("data-state", "disabled");
    await root.getByRole("button", { name: "Enable" }).click();
    await allSettled(page, { cupola_test: "attached", second: "attached" });
  });

  test("the History panel's All workspaces lists every workspace's queries, labelled", async ({ page }) => {
    test.setTimeout(90_000);
    const entry = (sql: string) => JSON.stringify([{ id: 1, timestamp: Date.now(), sql, executionTimeMs: 1, success: true, source: "editor" }]);
    await seed(page, {
      ...workspaceStore([TWO, { id: "ws-other", name: "Elsewhere", catalogs: [TWO.catalogs[1]] }]),
      "cupola.query-history.v1::ws-two": entry("SELECT 'here'"),
      "cupola.query-history.v1::ws-other": entry("SELECT 'elsewhere'"),
    });
    await page.goto(workspaceUrl("ws-two"));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openEditor(page);
    await page.getByTestId("editor-history").click();
    await page.getByTestId("editor-history-view-all").click();
    const history = page.getByTestId("editor-history-panel");
    await expect(history).toContainText("SELECT 'here'");
    await expect(history).not.toContainText("SELECT 'elsewhere'");
    await history.getByTestId("editor-history-all").check();
    await expect(history).toContainText("SELECT 'elsewhere'");
    await expect(history.getByTestId("editor-history-workspace").filter({ hasText: "Elsewhere" })).toHaveCount(1);
  });

  test("an Evidence report opens in its own workspace", async ({ page }) => {
    test.setTimeout(120_000);
    const report = { version: 1, id: "ws-report", title: "Workspace report", serviceUrl: SERVICE_URL, workspaceId: "ws-two", source: "# Workspace report\n\nIn its workspace.", setupSql: "", parameters: [], values: {}, createdAt: 1, updatedAt: 1 };
    await seed(page, { ...workspaceStore([TWO]), "cupola.evidence.report.v2:ws-two:ws-report": JSON.stringify(report) });
    await page.goto(`${workspaceUrl("ws-two", "reports")}&evidence_report=ws-report`);
    await expect(page.getByTestId("evidence-panel").getByTestId("evidence-document")).toContainText("In its workspace.", { timeout: 90_000 });
  });

  test("Share workspace link round-trips, and carries no secrets", async ({ page, context }) => {
    // cupola_secure declares region and requires the secret api_key.
    test.skip(!(await up(OPTIONS_URL)), `start the attach-options worker at ${OPTIONS_URL}`);
    test.setTimeout(120_000);
    await seed(page, {
      ...workspaceStore([{ ...TWO, catalogs: [{ id: "secure", url: OPTIONS_URL, catalogName: "cupola_secure", alias: "cupola_secure", options: { region: "eu" } }, TWO.catalogs[1]] }]),
      [SECRETS]: JSON.stringify({ "ws-two:secure:api_key": "never-in-a-link" }),
    });
    await page.goto(workspaceUrl("ws-two"));
    await allSettled(page, { cupola_secure: "attached", second: "attached" });
    await picker(page).click();
    await panel(page).getByTestId("workspace-share-open").click();
    const link = await panel(page).getByTestId("workspace-share-url").inputValue();
    expect(link).toContain("#ws=");
    expect(link).not.toContain("never-in-a-link");
    await expect(panel(page).getByTestId("workspace-share-omitted")).toContainText("api_key");

    const other = await context.newPage();
    await other.goto(link);
    const consent = other.getByTestId("workspace-consent");
    await expect(consent).toBeVisible({ timeout: T_SHELL_BOOT });
    await consent.getByRole("button", { name: "Attach 2 catalogs" }).click();
    // Without its api_key (the link has none) cupola_secure cannot attach.
    await allSettled(other, { cupola_secure: "failed", second: "attached" });
    // A link opens as a new untitled workspace; the named one is untouched.
    const stored = await other.evaluate((k) => JSON.parse(localStorage.getItem(k)!).workspaces, WORKSPACES);
    expect(stored.filter((w: any) => w.name === null)).toHaveLength(1);
    expect(stored.find((w: any) => w.id === "ws-two").name).toBe("Two catalogs");
    // The link's options came along; its secret did not.
    expect(JSON.stringify(stored.find((w: any) => w.name === null))).toContain('"region":"eu"');
  });
});
