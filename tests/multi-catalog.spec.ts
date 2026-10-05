import { test, expect, type Page } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { APP_ORIGIN, APP_URL, BASE, SERVICE_URL, T_SHELL_BOOT, shellQuery, waitForShellBridge } from "./helpers";

// Several catalogs in one tab (docs/multi-catalog.md, phase 1). Needs the
// test worker twice, on two ports; both serve `cupola_test`, which is also
// what makes the alias collide:
//
//   PORT=9009 ./test-worker/run.sh      (VGI_SERVICE_URL)
//   PORT=9011 ./test-worker/run.sh      (VGI_SECOND_SERVICE_URL)
//
// VGI_DEAD_SERVICE_URL names a port nothing listens on.
const SECOND_URL = process.env.VGI_SECOND_SERVICE_URL || "http://localhost:9011";
const DEAD_URL = process.env.VGI_DEAD_SERVICE_URL || "http://127.0.0.1:9199";

interface Catalog { url: string; catalogName: string; id?: string; alias?: string; options?: Record<string, string> }

/** A `#ws=` token, encoded the way lib/workspace/codec.ts does. */
function wsToken(catalogs: Catalog[], extra: Record<string, unknown> = {}): string {
  const json = JSON.stringify({ format: "cupola-workspaces", version: 1, workspaces: [{ catalogs, ...extra }] });
  return deflateRawSync(Buffer.from(json, "utf8")).toString("base64url");
}

const wsUrl = (catalogs: Catalog[], extra: Record<string, unknown> = {}, hash = "") =>
  `${APP_ORIGIN}${BASE}#ws=${wsToken(catalogs, extra)}${hash}`;

async function up(url: string): Promise<boolean> {
  try {
    // Node resolves localhost to ::1 first; the worker binds 127.0.0.1.
    return (await fetch(url.replace("//localhost", "//127.0.0.1"), { method: "GET" })).ok;
  } catch {
    return false;
  }
}

const sidebar = (page: Page) => page.getByTestId("catalog-sidebar");
const statuses = (page: Page) => page.evaluate(() => (window as any).__bridge?.catalogStatuses?.() ?? []);

async function consent(page: Page, count: number) {
  const panel = page.getByTestId("workspace-consent");
  await expect(panel).toBeVisible({ timeout: T_SHELL_BOOT });
  await panel.getByRole("button", { name: `Attach ${count === 1 ? "catalog" : `${count} catalogs`}` }).click();
}

async function allSettled(page: Page, expected: Record<string, string>) {
  await waitForShellBridge(page);
  await expect.poll(async () => Object.fromEntries((await statuses(page)).map((s: any) => [s.alias, s.state])), { timeout: T_SHELL_BOOT })
    .toEqual(expected);
}

/** The breadcrumb of the content panel: catalog › schema › object. */
const breadcrumb = (page: Page) => page.locator("main nav").first();

const TWO = [
  { url: SERVICE_URL, catalogName: "cupola_test", id: "first" },
  { url: SECOND_URL, catalogName: "cupola_test", id: "second" },
];

test.describe("multi-catalog workspaces", () => {
  test.beforeEach(async () => {
    test.skip(!(await up(SERVICE_URL)) || !(await up(SECOND_URL)), `start test workers at ${SERVICE_URL} and ${SECOND_URL}`);
  });

  test("a #ws= link asks first, then attaches both catalogs under de-duplicated aliases", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(wsUrl(TWO));
    const panel = page.getByTestId("workspace-consent");
    await expect(panel).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(panel).toContainText("This link wants to attach 2 catalogs");
    // The second catalog's name collides with the first: it is renamed once.
    await expect(panel).toContainText("cupola_test_2");
    await expect(panel).toContainText("already used by another catalog");
    // Nothing is attached before consent: the engine has not even started.
    expect(await page.evaluate(() => (window as any).__bridge?.catalogName ?? null)).toBeNull();

    await consent(page, 2);
    await expect(page).toHaveURL(/local_ws=/);
    expect(page.url()).not.toContain("#ws=");
    await allSettled(page, { cupola_test: "attached", cupola_test_2: "attached" });
    await expect(sidebar(page).getByRole("tree").getByText("cupola_test", { exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole("tree").getByText("cupola_test_2", { exact: true })).toBeVisible();

    const joined = await shellQuery(page,
      "SELECT count(*)::INTEGER AS n FROM cupola_test.small.regions a JOIN cupola_test_2.small.regions b USING (region)");
    expect(joined.error).toBeUndefined();
    expect(joined.rows?.[0]?.n).toBe(8);
    const dbs = await shellQuery(page, "SELECT database_name FROM duckdb_databases() WHERE type = 'vgi' ORDER BY 1");
    expect(dbs.rows?.map((r) => r.database_name)).toEqual(["cupola_test", "cupola_test_2"]);

    // Each catalog has its own connection snippet.
    await page.evaluate(() => { window.location.hash = "#/catalog/cupola_test_2"; });
    await expect(page.locator("pre code").filter({ hasText: "ATTACH" }).first())
      .toContainText(`AS "cupola_test_2" (TYPE vgi, LOCATION '${SECOND_URL}'`);

    // A reload of the same URL keeps the set and its aliases, without asking again.
    await page.reload();
    await expect(page.getByTestId("workspace-consent")).toHaveCount(0);
    await allSettled(page, { cupola_test: "attached", cupola_test_2: "attached" });
  });

  test("the default catalog gets USE, so unqualified names resolve against it", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(wsUrl(TWO, { defaultCatalogId: "second", defaultSchema: "small" }));
    await consent(page, 2);
    await allSettled(page, { cupola_test: "attached", cupola_test_2: "attached" });
    const current = await shellQuery(page, "SELECT current_database() AS db, current_schema() AS s");
    expect(current.rows?.[0]).toEqual({ db: "cupola_test_2", s: "small" });
    const unqualified = await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM regions");
    expect(unqualified.rows?.[0]?.n).toBe(8);
    expect(await page.evaluate(() => (window as any).__bridge.catalogName)).toBe("cupola_test_2");
    expect(await page.evaluate(() => (window as any).__bridge.defaultCatalog)).toMatchObject({ alias: "cupola_test_2", schema: "small", fellBack: false });
  });

  test("one catalog failing leaves the other working, with its failure on its root", async ({ page }) => {
    test.setTimeout(90_000);
    // The live region holds only the latest batch; keep every announcement.
    await page.addInitScript(() => {
      const seen: string[] = ((window as any).__announced = []);
      new MutationObserver(() => {
        const text = document.querySelector('[data-testid="catalog-status-announcer"]')?.textContent;
        if (text && seen[seen.length - 1] !== text) seen.push(text);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await page.goto(wsUrl([
      { url: DEAD_URL, catalogName: "nowhere", id: "dead" },
      { url: SERVICE_URL, catalogName: "cupola_test" },
    ], { defaultCatalogId: "dead" }));
    await consent(page, 2);
    await allSettled(page, { nowhere: "failed", cupola_test: "attached" });
    // The engine itself is fine, and the default fell back to the catalog that attached.
    expect(await page.evaluate(() => (window as any).__bridge.engineStatus)).toBe("ready");
    expect(await page.evaluate(() => (window as any).__bridge.defaultCatalog)).toMatchObject({ alias: "cupola_test", requested: "nowhere", fellBack: true });
    const ok = await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM cupola_test.small.regions");
    expect(ok.rows?.[0]?.n).toBe(8);

    const root = sidebar(page).locator('[data-testid="catalog-status-root"][data-alias="nowhere"]');
    await expect(root).toHaveAttribute("data-state", "failed");
    await expect(root).toContainText("Failed");
    await expect.poll(() => page.evaluate(() => (window as any).__announced.join(" | "))).toContain("nowhere failed to attach");
    await expect.poll(() => page.evaluate(() => (window as any).__announced.join(" | "))).toContain("cupola_test attached");
    await root.getByRole("button", { name: "Details" }).click();
    const panelEl = page.getByTestId("attach-error-panel");
    await expect(panelEl).toBeVisible();
    await expect(panelEl).toContainText("Could not reach nowhere");
    await expect(page.getByTestId("attach-error-sql")).toContainText(`ATTACH OR REPLACE 'nowhere' AS "nowhere" (TYPE vgi, LOCATION '${DEAD_URL}')`);
    await expect(panelEl).toContainText("HTTP status: unreachable");
    await panelEl.getByRole("button", { name: "Dismiss" }).click();

    // Retry runs the same path again; the server is still down.
    await root.getByRole("button", { name: "Retry" }).click();
    await expect(root).toHaveAttribute("data-state", "failed", { timeout: T_SHELL_BOOT });
  });

  test("every catalog failing is one screen, listing each with Retry", async ({ page }) => {
    await page.goto(wsUrl([
      { url: DEAD_URL, catalogName: "nowhere" },
      { url: DEAD_URL.replace(/:\d+$/, ":9198"), catalogName: "elsewhere" },
    ]));
    await consent(page, 2);
    const screen = page.getByTestId("catalogs-failed");
    await expect(screen).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(screen.getByTestId("catalog-failed-row")).toHaveCount(2);
    await expect(screen).toContainText("nowhere");
    await expect(screen).toContainText("elsewhere");
    await expect(screen.getByRole("button", { name: "Retry" })).toHaveCount(2);
  });

  test("a deep link opens a table in the second catalog, and back/forward move between catalogs", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(wsUrl(TWO));
    await consent(page, 2);
    await allSettled(page, { cupola_test: "attached", cupola_test_2: "attached" });

    // A cold load straight onto the deep link.
    await page.goto(`${page.url().split("#")[0]}#/catalog/cupola_test_2/schema/small/table/regions`);
    await expect(breadcrumb(page)).toContainText("cupola_test_2", { timeout: T_SHELL_BOOT });
    await expect(breadcrumb(page)).toContainText("regions");
    await expect(page).toHaveTitle("cupola_test_2 / small / regions - VGI");

    // Navigate to the other catalog through the sidebar.
    const tree = sidebar(page).getByRole("tree");
    await page.evaluate(() => { history.pushState(null, "", location.pathname + location.search + "#/catalog/cupola_test/schema/small/table/products"); dispatchEvent(new PopStateEvent("popstate")); });
    await expect(breadcrumb(page)).toContainText("products");
    await expect(breadcrumb(page)).not.toContainText("cupola_test_2");
    await expect(tree).toBeVisible();

    await page.goBack();
    await expect(breadcrumb(page)).toContainText("regions");
    await expect(breadcrumb(page)).toContainText("cupola_test_2");
    await page.goForward();
    await expect(breadcrumb(page)).toContainText("products");
    await expect(page).toHaveURL(/#\/catalog\/cupola_test\/schema\/small\/table\/products$/);

    // Clicking the breadcrumb's catalog navigates to that catalog's root.
    await breadcrumb(page).getByRole("link", { name: "cupola_test" }).click();
    await expect(page).toHaveURL(/#\/catalog\/cupola_test$/);
  });

  test("a legacy #/schema/… link resolves against the default catalog", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(wsUrl(TWO, { defaultCatalogId: "second" }));
    await consent(page, 2);
    await allSettled(page, { cupola_test: "attached", cupola_test_2: "attached" });
    await page.goto(`${page.url().split("#")[0]}#/schema/small/table/regions`);
    await expect(breadcrumb(page)).toContainText("cupola_test_2", { timeout: T_SHELL_BOOT });
    await expect(breadcrumb(page)).toContainText("regions");
  });
});

test.describe("single catalog (?service=)", () => {
  test("a legacy #/schema/… link still opens the table, in the service's catalog", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${APP_URL}#/schema/small/table/regions`);
    await expect(breadcrumb(page)).toContainText("cupola_test", { timeout: T_SHELL_BOOT });
    await expect(breadcrumb(page)).toContainText("regions");
    // A single catalog keeps the old sidebar: no status rows.
    await expect(page.getByTestId("catalog-status-roots")).toHaveCount(0);
    await waitForShellBridge(page);
    expect(await page.evaluate(() => (window as any).__bridge.catalogStatuses().map((s: any) => [s.alias, s.state]))).toEqual([["cupola_test", "attached"]]);
    const current = await shellQuery(page, "SELECT current_database() AS db");
    expect(current.rows?.[0]?.db).toBe("cupola_test");
  });
});
