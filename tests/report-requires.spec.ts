import { test, expect, type Page } from "@playwright/test";
import { APP_ORIGIN, BASE, SERVICE_URL, T_NORMAL, T_SHELL_BOOT } from "./helpers";

// Reports' `requires` (docs/multi-catalog.md, phase 3): a report written for a catalog this
// workspace has under another alias offers Rebind; one reading a catalog it lacks offers Attach
// (the picker's attach form, prefilled) or Open anyway.
//
//   PORT=9009 ./test-worker/run.sh   (VGI_SERVICE_URL)
//   PORT=9011 ./test-worker/run.sh   (VGI_SECOND_SERVICE_URL)
const SECOND_URL = process.env.VGI_SECOND_SERVICE_URL || "http://localhost:9011";
const WS = "ws-requires";
const reportKey = (id: string) => `cupola.evidence.report.v2:${encodeURIComponent(WS)}:${encodeURIComponent(id)}`;
const historyKey = (id: string) => `cupola.evidence.history.v1:${encodeURIComponent(WS)}:${encodeURIComponent(id)}`;

async function up(url: string): Promise<boolean> {
  try { return (await fetch(url.replace("//localhost", "//127.0.0.1"))).ok; } catch { return false; }
}

/** A workspace holding the test catalog as `local_alias`, and two reports: one written for it as
 *  `cupola_test`, one reading a second worker's catalog the workspace doesn't have. */
async function seed(page: Page) {
  const now = Date.now();
  const report = (id: string, title: string, sql: string, requires: unknown[]) => JSON.stringify({
    version: 1, id, title, workspaceId: WS, serviceUrl: SERVICE_URL, createdAt: now, updatedAt: now,
    source: `# ${title}\n\n\`\`\`sql rows\n${sql}\n\`\`\`\n\n{% table data="rows" /%}\n`, setupSql: "", parameters: [], values: {}, requires,
  });
  const entries: Record<string, string> = {
    "cupola.workspaces.migrated.v1": JSON.stringify({ at: now }),
    "cupola.workspaces.v1": JSON.stringify({ version: 1, workspaces: [{
      id: WS, name: "Requires test", defaultCatalogId: "c1", createdAt: now, updatedAt: now, lastOpenedAt: now,
      catalogs: [{ id: "c1", url: SERVICE_URL, catalogName: "cupola_test", alias: "local_alias", options: {} }],
    }] }),
    "cupola.workspaces.local.v1": JSON.stringify({ version: 1, workspaces: {} }),
    [reportKey("rebind")]: report("rebind", "Needs rebind", "SELECT count(*) AS n FROM cupola_test.small.numbers",
      [{ alias: "cupola_test", url: SERVICE_URL, catalogName: "cupola_test" }]),
    [reportKey("missing")]: report("missing", "Needs attach", "SELECT count(*) AS n FROM elsewhere.small.numbers",
      [{ alias: "elsewhere", url: SECOND_URL, catalogName: "cupola_test" }]),
  };
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
  }, entries);
}

const openReport = (page: Page, id: string) => page.goto(`${APP_ORIGIN}${BASE}reports?local_ws=${WS}&evidence_report=${id}`);

test.describe("report requires", () => {
  test.beforeEach(async () => {
    test.skip(!(await up(SERVICE_URL)), `start a test worker at ${SERVICE_URL}`);
  });

  test("Rebind rewrites the report to this workspace's alias, with a revision", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page);
    await openReport(page, "rebind");
    const banner = page.getByTestId("report-requires-banner");
    await expect(banner).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(banner).toContainText("cupola_test");
    await expect(banner).toContainText("local_alias");
    await banner.getByRole("button", { name: "Rebind" }).click();
    await expect(banner).toBeHidden({ timeout: T_NORMAL });
    const stored = await page.evaluate(([r, h]) => ({ report: JSON.parse(localStorage.getItem(r)!), history: JSON.parse(localStorage.getItem(h) ?? "null") }), [reportKey("rebind"), historyKey("rebind")]);
    expect(stored.report.source).toContain("FROM local_alias.small.numbers");
    expect(stored.report.requires).toEqual([{ alias: "local_alias", url: SERVICE_URL, catalogName: "cupola_test" }]);
    expect(stored.history.revisions.at(-1).label).toBe("Rebound catalog cupola_test → local_alias");
    // It now runs against this workspace.
    await expect(page.getByTestId("evidence-preview")).toBeVisible({ timeout: T_SHELL_BOOT });
  });

  test("a missing catalog offers Attach (prefilled) or Open anyway", async ({ page }) => {
    test.setTimeout(90_000);
    await seed(page);
    await openReport(page, "missing");
    const banner = page.getByTestId("report-requires-banner");
    await expect(banner).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(banner).toContainText("elsewhere");
    await banner.getByRole("button", { name: "Attach elsewhere…" }).click();
    const panel = page.getByTestId("workspace-picker-panel");
    await expect(panel).toBeVisible({ timeout: T_NORMAL });
    await expect(panel.locator("input").first()).toHaveValue(SECOND_URL);
    await page.keyboard.press("Escape");
    await banner.getByRole("button", { name: "Open anyway" }).click();
    await expect(banner).toBeHidden();
  });

  test("attaching the missing catalog under its alias clears the banner", async ({ page }) => {
    test.skip(!(await up(SECOND_URL)), `start a second test worker at ${SECOND_URL}`);
    test.setTimeout(120_000);
    await seed(page);
    await openReport(page, "missing");
    const banner = page.getByTestId("report-requires-banner");
    await expect(banner).toBeVisible({ timeout: T_SHELL_BOOT });
    await banner.getByRole("button", { name: "Attach elsewhere…" }).click();
    const panel = page.getByTestId("workspace-picker-panel");
    await panel.getByRole("button", { name: /^Attach/ }).last().click();
    await expect(banner).toBeHidden({ timeout: T_SHELL_BOOT });
  });
});
