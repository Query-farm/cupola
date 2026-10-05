import { test, expect, type Page } from "@playwright/test";
import { APP_ORIGIN, BASE, SERVICE_URL, T_NORMAL, T_SHELL_BOOT, openEditor, openShell, waitForShellBridge } from "./helpers";

// The ⌘K / Ctrl+K command palette (docs/multi-catalog.md, phase 3).
//
//   PORT=9009 ./test-worker/run.sh   (VGI_SERVICE_URL)
const SHORTCUT = process.platform === "darwin" ? "Meta+k" : "Control+k";
const WS = "ws-palette";

async function up(url: string): Promise<boolean> {
  try { return (await fetch(url.replace("//localhost", "//127.0.0.1"))).ok; } catch { return false; }
}

async function seed(page: Page) {
  const now = Date.now();
  const entries: Record<string, string> = {
    "cupola.workspaces.migrated.v1": JSON.stringify({ at: now }),
    "cupola.workspaces.v1": JSON.stringify({ version: 1, workspaces: [
      { id: WS, name: "Palette test", defaultCatalogId: "c1", createdAt: now, updatedAt: now, lastOpenedAt: now,
        catalogs: [{ id: "c1", url: SERVICE_URL, catalogName: "cupola_test", alias: "cupola_test", options: {} }] },
      { id: "ws-other", name: "Other workspace", defaultCatalogId: "o1", createdAt: now, updatedAt: now, lastOpenedAt: now - 1,
        catalogs: [{ id: "o1", url: SERVICE_URL, catalogName: "cupola_test", alias: "other", options: {} }] },
    ] }),
    "cupola.workspaces.local.v1": JSON.stringify({ version: 1, workspaces: {} }),
  };
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
  }, entries);
}

const palette = (page: Page) => page.getByTestId("command-palette");

test.describe("command palette", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await up(SERVICE_URL)), `start a test worker at ${SERVICE_URL}`);
    await seed(page);
    await page.goto(`${APP_ORIGIN}${BASE}?local_ws=${WS}`);
    await waitForShellBridge(page, T_SHELL_BOOT);
  });

  test("opens with the shortcut, filters, and is an accessible listbox", async ({ page }) => {
    await page.keyboard.press(SHORTCUT);
    await expect(palette(page)).toBeVisible({ timeout: T_NORMAL });
    const input = palette(page).getByRole("combobox");
    await expect(input).toBeFocused();
    await expect(palette(page).getByRole("listbox")).toBeVisible();
    await expect(palette(page).getByRole("option", { name: "Attach catalog…" })).toBeVisible();
    await input.fill("mng wrk");
    await expect(palette(page).getByRole("option").first()).toHaveText(/Manage workspaces/);
    await expect(palette(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(palette(page)).toBeHidden();
  });

  test("keyboard navigation moves the active option", async ({ page }) => {
    await page.keyboard.press(SHORTCUT);
    const input = palette(page).getByRole("combobox");
    const first = await input.getAttribute("aria-activedescendant");
    await page.keyboard.press("ArrowDown");
    const second = await input.getAttribute("aria-activedescendant");
    expect(second).not.toBe(first);
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    expect(await input.getAttribute("aria-activedescendant")).toBe(first);
  });

  test("Switch workspace… opens a page of workspaces and switches", async ({ page }) => {
    await page.keyboard.press(SHORTCUT);
    await palette(page).getByRole("combobox").fill("switch workspace");
    await page.keyboard.press("Enter");
    await expect(palette(page).getByRole("option", { name: /Other workspace/ })).toBeVisible();
    // Backspace in the empty field goes back to the root.
    await page.keyboard.press("Backspace");
    await expect(palette(page).getByRole("option", { name: "Attach catalog…" })).toBeVisible();
    await palette(page).getByRole("combobox").fill("other workspace");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/local_ws=ws-other/, { timeout: T_NORMAL });
  });

  test("Attach catalog… opens the picker's attach form", async ({ page }) => {
    await page.keyboard.press(SHORTCUT);
    await palette(page).getByRole("combobox").fill("attach catalog");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workspace-picker-panel")).toBeVisible({ timeout: T_NORMAL });
  });

  test("opens from the SQL editor, but the shell keeps the shortcut to clear itself", async ({ page }) => {
    await openEditor(page);
    await page.locator(".cm-content").first().click();
    await page.keyboard.press(SHORTCUT);
    await expect(palette(page)).toBeVisible({ timeout: T_NORMAL });
    await page.keyboard.press("Escape");
    await openShell(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press(SHORTCUT);
    await expect(palette(page)).toBeHidden();
  });
});
