import { test, expect, type Page } from "@playwright/test";
import { APP_ORIGIN, BASE, SERVICE_URL, T_NORMAL, T_SHELL_BOOT, shellQuery, waitForShellBridge } from "./helpers";

// Manage workspaces (docs/multi-catalog.md, phase 3): the two-pane manager,
// opened from the picker and from the welcome page. Needs two plain test
// workers, plus the attach-options variant for the options tests:
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

const workspaceUrl = (id: string) => `${APP_ORIGIN}${BASE}?local_ws=${encodeURIComponent(id)}`;
const statuses = (page: Page) => page.evaluate(() => (window as any).__bridge?.catalogStatuses?.() ?? []);
const picker = (page: Page) => page.getByTestId("workspace-picker");
const panel = (page: Page) => page.getByTestId("workspace-picker-panel");
const manager = (page: Page) => page.getByTestId("workspace-manager");
const detail = (page: Page) => manager(page).getByTestId("workspace-manager-detail");
const catalogRow = (page: Page, alias: string) => detail(page).locator(`[data-testid="workspace-manager-catalog"][data-alias="${alias}"]`);
const storedOrder = (page: Page, id: string) => page.evaluate(([key, wsId]) => {
  const file = JSON.parse(localStorage.getItem(key) ?? "{}");
  return (file.workspaces ?? []).find((w: any) => w.id === wsId)?.catalogs.map((c: any) => c.alias) ?? [];
}, [WORKSPACES, id]);

async function allSettled(page: Page, expected: Record<string, string>) {
  await waitForShellBridge(page);
  await expect.poll(async () => Object.fromEntries((await statuses(page)).map((s: any) => [s.alias, s.state])), { timeout: T_SHELL_BOOT })
    .toEqual(expected);
}

interface SeedCatalog { id: string; url: string; catalogName: string; alias: string; options?: Record<string, string> }
interface SeedWorkspace { id: string; name: string | null; catalogs: SeedCatalog[]; defaultCatalogId?: string }

async function seed(page: Page, entries: Record<string, string>) {
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
  }, entries);
}

function workspaceStore(workspaces: SeedWorkspace[]): Record<string, string> {
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
    [OVERLAY]: JSON.stringify({ version: 1, workspaces: {} }),
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
const OTHER: SeedWorkspace = {
  id: "ws-other",
  name: "Another one",
  catalogs: [{ id: "o1", url: SECOND_URL, catalogName: "cupola_test", alias: "elsewhere" }],
};

async function openManager(page: Page) {
  await picker(page).click();
  await panel(page).getByRole("button", { name: "Manage workspaces…" }).click();
  await expect(manager(page)).toBeVisible({ timeout: T_NORMAL });
}

test.describe("workspace manager", () => {
  test.beforeEach(async () => {
    test.skip(!(await up(SERVICE_URL)) || !(await up(SECOND_URL)), `start test workers at ${SERVICE_URL} and ${SECOND_URL}`);
  });

  test("opens from the picker on the open workspace, and Escape closes it", async ({ page }) => {
    await seed(page, workspaceStore([TWO, OTHER]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openManager(page);
    await expect(manager(page).getByRole("heading", { name: "Manage workspaces" })).toBeVisible();
    const items = manager(page).getByTestId("workspace-manager-item");
    await expect(items).toHaveCount(2);
    await expect(manager(page).locator('[data-testid="workspace-manager-item"][aria-current="true"]')).toContainText("Two catalogs");
    await expect(detail(page)).toHaveAttribute("data-workspace-id", TWO.id);
    // Status is icon plus text.
    await expect(catalogRow(page, "second")).toContainText("Attached");
    // The open workspace cannot be deleted; the reason is said.
    await expect(detail(page).getByTestId("workspace-manager-delete")).toBeDisabled();
    await expect(detail(page)).toContainText("can't be deleted here");
    await page.keyboard.press("Escape");
    await expect(manager(page)).toBeHidden();
  });

  test("renames and duplicates a workspace; deletes another after confirming", async ({ page }) => {
    await seed(page, workspaceStore([TWO, OTHER]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openManager(page);

    const name = detail(page).getByTestId("workspace-manager-name");
    await name.fill("Finance Q3");
    await name.press("Enter");
    await expect(picker(page)).toContainText("Finance Q3");

    await detail(page).getByTestId("workspace-manager-duplicate").click();
    await expect(manager(page).getByTestId("workspace-manager-item")).toHaveCount(3);
    await expect(detail(page).getByTestId("workspace-manager-name")).toHaveValue("Finance Q3 (copy)");
    // Same aliases, new ids.
    await expect(catalogRow(page, "cupola_test")).toBeVisible();
    await expect(catalogRow(page, "second")).toBeVisible();
    const ids = await detail(page).getByTestId("workspace-manager-catalog").evaluateAll((els) => els.map((e) => e.getAttribute("data-catalog-id")));
    expect(ids).not.toContain("first");
    expect(ids).not.toContain("second");

    await manager(page).getByTestId("workspace-manager-item").filter({ hasText: "Another one" }).click();
    await detail(page).getByTestId("workspace-manager-delete").click();
    const confirm = detail(page).getByTestId("workspace-manager-delete-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirm.getByTestId("workspace-manager-delete-confirm-button").click();
    await expect(manager(page).getByTestId("workspace-manager-item").filter({ hasText: "Another one" })).toHaveCount(0);
  });

  test("reorders catalogs by keyboard and by the ⋯ menu, and the sidebar follows", async ({ page }) => {
    await seed(page, workspaceStore([TWO]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openManager(page);

    const handle = catalogRow(page, "second").getByTestId("catalog-drag-handle");
    await handle.focus();
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => storedOrder(page, TWO.id)).toEqual(["second", "cupola_test"]);
    // Focus stays on the moved catalog's handle, and the move is announced.
    await expect(catalogRow(page, "second").getByTestId("catalog-drag-handle")).toBeFocused();
    await expect(detail(page).getByRole("status")).toContainText("Moved second to position 1 of 2.");

    await catalogRow(page, "second").getByTestId("catalog-more").click();
    await page.getByRole("menu", { name: "More actions for second" }).getByRole("menuitem", { name: "Move down" }).click();
    await expect.poll(() => storedOrder(page, TWO.id)).toEqual(["cupola_test", "second"]);
    await expect(page.getByRole("menu", { name: "More actions for second" })).toBeHidden();

    await catalogRow(page, "cupola_test").getByTestId("catalog-more").click();
    await expect(page.getByRole("menu", { name: "More actions for cupola_test" }).getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    await page.keyboard.press("Escape");
  });

  test("reorders by dragging a handle", async ({ page }) => {
    await seed(page, workspaceStore([TWO]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openManager(page);
    await catalogRow(page, "second").getByTestId("catalog-drag-handle").dragTo(catalogRow(page, "cupola_test"), { targetPosition: { x: 20, y: 4 } });
    await expect.poll(() => storedOrder(page, TWO.id)).toEqual(["second", "cupola_test"]);
  });

  test("the default radio, enabled switch and Remove apply to the running engine", async ({ page }) => {
    await seed(page, workspaceStore([TWO]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openManager(page);

    await catalogRow(page, "second").getByTestId("catalog-default-radio").check();
    await expect.poll(() => page.evaluate(() => (window as any).__bridge?.defaultCatalog?.alias)).toBe("second");

    await catalogRow(page, "cupola_test").getByTestId("catalog-enabled-switch").click();
    await allSettled(page, { cupola_test: "disabled", second: "attached" });
    await catalogRow(page, "cupola_test").getByTestId("catalog-enabled-switch").click();
    await allSettled(page, { cupola_test: "attached", second: "attached" });

    await catalogRow(page, "cupola_test").getByTestId("catalog-more").click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await catalogRow(page, "cupola_test").getByTestId("catalog-remove-confirm-button").click();
    await expect(catalogRow(page, "cupola_test")).toHaveCount(0);
    await expect.poll(async () => (await statuses(page)).map((s: any) => s.alias)).toEqual(["second"]);
  });

  test("an alias is validated as typed, and a rename re-attaches under the new name", async ({ page }) => {
    await seed(page, workspaceStore([TWO]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openManager(page);
    await catalogRow(page, "second").getByTestId("catalog-edit-toggle").click();
    const editor = catalogRow(page, "second").getByTestId("catalog-editor");
    const alias = editor.getByTestId("catalog-alias-input");
    await alias.fill("memory");
    await expect(editor).toContainText("reserved");
    await expect(alias).toHaveAttribute("aria-invalid", "true");
    await alias.fill("cupola_test");
    await expect(editor).toContainText("already used");
    await alias.fill("2nd");
    await expect(editor).toContainText("Letters, digits");
    await alias.fill("renamed");
    await expect(alias).toHaveAttribute("aria-invalid", "false");
    // The app's handler is the alias-rename dialog, with the alias fixed to the draft's.
    await editor.getByTestId("catalog-editor-save").click();
    const dialog = page.getByTestId("alias-rename-dialog");
    await expect(dialog).toBeVisible({ timeout: T_NORMAL });
    await expect(dialog.getByRole("heading")).toHaveText("Rename catalog second");
    await expect(dialog.getByRole("textbox")).toHaveValue("renamed");
    await expect(dialog.getByRole("textbox")).toHaveAttribute("readonly", "");
    await expect(dialog.getByTestId("alias-rename-none")).toBeVisible();
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: T_NORMAL });
    await allSettled(page, { cupola_test: "attached", renamed: "attached" });
    expect((await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM renamed.small.regions")).rows?.[0]?.n).toBe(8);
  });

  test("cancelling the alias-rename dialog saves nothing", async ({ page }) => {
    await seed(page, workspaceStore([TWO]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached", second: "attached" });
    await openManager(page);
    await catalogRow(page, "second").getByTestId("catalog-edit-toggle").click();
    const editor = catalogRow(page, "second").getByTestId("catalog-editor");
    await editor.getByTestId("catalog-alias-input").fill("renamed");
    await editor.getByTestId("catalog-editor-save").click();
    const dialog = page.getByTestId("alias-rename-dialog");
    await expect(dialog).toBeVisible({ timeout: T_NORMAL });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(editor.getByTestId("catalog-editor-errors")).toContainText('still "second"');
    expect(await storedOrder(page, TWO.id)).toEqual(["cupola_test", "second"]);
  });

  test("Test connection shows the schema count and latency, or the error", async ({ page }) => {
    await seed(page, workspaceStore([{
      ...TWO,
      catalogs: [...TWO.catalogs, { id: "dead", url: "http://localhost:1", catalogName: "nowhere", alias: "nowhere" }],
    }]));
    await page.goto(workspaceUrl(TWO.id));
    await waitForShellBridge(page);
    await openManager(page);
    await catalogRow(page, "second").getByTestId("catalog-test-button").click();
    const ok = catalogRow(page, "second").getByTestId("catalog-test-result");
    await expect(ok).toHaveAttribute("data-ok", "true", { timeout: T_SHELL_BOOT });
    await expect(ok).toContainText(/Connected in \d+ ms · \d+ schemas?/);
    await catalogRow(page, "nowhere").getByTestId("catalog-test-button").click();
    const bad = catalogRow(page, "nowhere").getByTestId("catalog-test-result");
    await expect(bad).toHaveAttribute("data-ok", "false", { timeout: T_SHELL_BOOT });
    await expect(bad).toContainText("Failed after");
  });

  test("+ Add catalog attaches into the open workspace", async ({ page }) => {
    await seed(page, workspaceStore([{ ...TWO, catalogs: [TWO.catalogs[0]] }]));
    await page.goto(workspaceUrl(TWO.id));
    await allSettled(page, { cupola_test: "attached" });
    await openManager(page);
    await detail(page).getByTestId("workspace-manager-add-catalog").click();
    const form = detail(page).getByTestId("attach-catalog-form");
    await form.getByTestId("attach-catalog-url").fill(SECOND_URL);
    await expect(form.getByTestId("attach-catalog-alias")).toHaveValue("cupola_test_2", { timeout: T_SHELL_BOOT });
    await form.getByTestId("attach-catalog-alias").fill("added");
    await form.getByTestId("attach-catalog-submit").click();
    await expect(catalogRow(page, "added")).toBeVisible();
    await allSettled(page, { cupola_test: "attached", added: "attached" });
  });

  test("the footer keeps the workspace-file slot free and has Done", async ({ page }) => {
    await seed(page, workspaceStore([TWO]));
    await page.goto(workspaceUrl(TWO.id));
    await waitForShellBridge(page);
    await openManager(page);
    await manager(page).getByTestId("workspace-manager-footer").getByRole("button", { name: "Done" }).click();
    await expect(manager(page)).toBeHidden();
  });
});

test.describe("workspace manager options", () => {
  test.beforeEach(async () => {
    test.skip(!(await up(SERVICE_URL)) || !(await up(OPTIONS_URL)), `start test workers at ${SERVICE_URL} and ${OPTIONS_URL}`);
  });

  const SECURE: SeedWorkspace = {
    id: "ws-opts",
    name: "With options",
    catalogs: [
      { id: "plain", url: SERVICE_URL, catalogName: "cupola_test", alias: "cupola_test" },
      { id: "secure", url: OPTIONS_URL, catalogName: "cupola_secure", alias: "cupola_secure" },
    ],
  };

  test("the options grid is typed from the specs; a secret is masked, revealable and kept out of the record", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, workspaceStore([SECURE]));
    await page.goto(workspaceUrl(SECURE.id));
    await allSettled(page, { cupola_test: "attached", cupola_secure: "failed" });
    await openManager(page);
    await catalogRow(page, "cupola_secure").getByTestId("catalog-edit-toggle").click();
    const editor = catalogRow(page, "cupola_secure").getByTestId("catalog-editor");

    const apiKey = editor.locator('[data-option="api_key"]');
    await expect(apiKey).toHaveAttribute("data-kind", "secret", { timeout: T_SHELL_BOOT });
    await expect(apiKey.getByTestId("option-required")).toBeVisible();
    await expect(apiKey).toContainText("API key for the test catalog");
    await expect(editor.locator('[data-option="max_rows"]')).toHaveAttribute("data-kind", "integer");
    await expect(editor.locator('[data-option="max_rows"] input')).toHaveAttribute("type", "number");
    await expect(editor.locator('[data-option="region"]')).toHaveAttribute("data-kind", "text");

    const input = apiKey.locator("input");
    await input.fill("manager-secret");
    await expect(input).toHaveAttribute("type", "password");
    await apiKey.getByTestId("option-reveal").click();
    await expect(input).toHaveAttribute("type", "text");
    await apiKey.getByTestId("option-reveal").click();
    await expect(input).toHaveAttribute("type", "password");

    await editor.getByTestId("catalog-editor-save").click();
    await allSettled(page, { cupola_test: "attached", cupola_secure: "attached" });
    const stored = await page.evaluate(([w, s]) => ({ ws: localStorage.getItem(w)!, secrets: localStorage.getItem(s)! }), [WORKSPACES, SECRETS]);
    expect(stored.ws).not.toContain("manager-secret");
    expect(stored.secrets).toContain("ws-opts:secure:api_key");
  });

  test("the SQL tab edits the options as text, parse-validated, without secrets", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, workspaceStore([SECURE]));
    await page.goto(workspaceUrl(SECURE.id));
    await allSettled(page, { cupola_test: "attached", cupola_secure: "failed" });
    await openManager(page);
    await catalogRow(page, "cupola_secure").getByTestId("catalog-edit-toggle").click();
    const editor = catalogRow(page, "cupola_secure").getByTestId("catalog-editor");
    await expect(editor.locator('[data-option="api_key"]')).toBeVisible({ timeout: T_SHELL_BOOT });
    await editor.locator('[data-option="api_key"] input').fill("sql-tab-secret");
    await editor.locator('[data-option="region"] input').fill("eu-west-1");

    await editor.getByTestId("catalog-sql-tab").click();
    const text = editor.getByTestId("catalog-sql-text");
    await expect(text).toHaveValue("region 'eu-west-1'");
    await expect(text).not.toHaveValue(/sql-tab-secret/);

    // Not name/value pairs: refused, and the tab stays put.
    await text.fill("region 'x'); DROP TABLE t; --");
    await editor.getByTestId("catalog-options-tab").click();
    await expect(editor.getByTestId("catalog-editor-errors")).toBeVisible();
    await expect(text).toBeVisible();

    await text.fill("region 'ap-south-1', max_rows 7");
    await editor.getByTestId("catalog-options-tab").click();
    await expect(editor.locator('[data-option="region"] input')).toHaveValue("ap-south-1");
    await expect(editor.locator('[data-option="max_rows"] input')).toHaveValue("7");

    await editor.getByTestId("catalog-editor-save").click();
    await allSettled(page, { cupola_test: "attached", cupola_secure: "attached" });
    const ws = await page.evaluate((k) => localStorage.getItem(k)!, WORKSPACES);
    expect(ws).toContain("ap-south-1");
    expect(ws).not.toContain("sql-tab-secret");
  });
});

test.describe("workspace manager on the welcome page", () => {
  test("opens from the welcome page and edits a stored workspace without attaching anything", async ({ page }) => {
    await seed(page, workspaceStore([TWO, OTHER]));
    await page.goto(`${APP_ORIGIN}${BASE}`);
    await page.getByTestId("welcome-manage-workspaces").first().click();
    await expect(manager(page)).toBeVisible();
    await manager(page).getByTestId("workspace-manager-item").filter({ hasText: "Two catalogs" }).click();
    // Nothing is open, so any workspace can be deleted, and edits are store-only.
    await expect(detail(page).getByTestId("workspace-manager-delete")).toBeEnabled();
    await catalogRow(page, "second").getByTestId("catalog-more").click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect.poll(() => storedOrder(page, TWO.id)).toEqual(["second", "cupola_test"]);
    await detail(page).getByTestId("workspace-manager-open").click();
    await expect(page).toHaveURL(/local_ws=ws-two/);
  });
});
