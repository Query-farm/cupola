/**
 * The sidebar while the Query Editor is open: clicking opens the Inspector,
 * hovering previews, inserting writes a call with tab-stop arguments, and the
 * editor shows signature help for catalog functions. Runs on the test
 * worker's `cupola_test` catalog (`edge.slow_rows(rows, delay_ms)`).
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openEditor, waitForShellBridge, typeInEditor, T_NORMAL, T_SHELL_BOOT } from "./helpers";

async function reveal(page: Page, name: string) {
  await page.getByLabel("Filter catalog").fill(name);
  const item = page.getByRole("treeitem", { name: new RegExp(`^${name}`) }).first();
  await expect(item).toBeVisible({ timeout: T_NORMAL });
  return item;
}

async function editorText(page: Page) {
  return page.locator(".cm-content").first().innerText();
}

async function clearEditor(page: Page) {
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
  await clearEditor(page);
});

test.describe("Sidebar in the query editor", () => {
  test("clicking a function opens it in the Inspector without leaving the editor", async ({ page }) => {
    const hashBefore = await page.evaluate(() => history.length);
    await (await reveal(page, "slow_rows")).click();
    const inspector = page.getByTestId("editor-inspector");
    await expect(inspector).toBeVisible({ timeout: T_NORMAL });
    await expect(page.getByTestId("sql-editor-view")).toBeVisible();
    await expect(page.getByTestId("inspector-title")).toHaveText("slow_rows");
    await expect(inspector.getByTestId("callable-signature")).toContainText("slow_rows(rows");
    await expect(inspector.getByTestId("inspector-args")).toContainText("delay_ms");
    // The one-line summary leads; a server's vgi.doc_md would follow it under "Documentation".
    await expect(inspector.getByTestId("inspector-summary")).toContainText("Rows that arrive slowly");
    // Browsing from the editor replaces the history entry rather than adding one.
    expect(await page.evaluate(() => history.length)).toBe(hashBefore);
    await expect(page.getByTestId("editor-inspector-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  test("tables show their columns; pin keeps the Inspector on one object", async ({ page }) => {
    await (await reveal(page, "slow_rows")).click();
    await expect(page.getByTestId("inspector-title")).toHaveText("slow_rows");
    await page.getByTestId("inspector-pin").click();

    await page.getByLabel("Filter catalog").fill("");
    const table = page.getByRole("treeitem", { name: /^regions/ }).first();
    await page.getByLabel("Filter catalog").fill("regions");
    await expect(table).toBeVisible({ timeout: T_NORMAL });
    await table.click();
    await expect(page.getByTestId("inspector-title")).toHaveText("slow_rows");

    await page.getByTestId("inspector-pin").click(); // unpin: follow the sidebar again
    await table.click();
    await expect(page.getByTestId("inspector-title")).toHaveText("regions");
    await expect(page.getByTestId("inspector-columns").getByTestId("inspector-column").first()).toBeVisible();

    // Clicking a column name writes it into the query.
    const first = page.getByTestId("inspector-column").first();
    const name = (await first.innerText()).trim();
    await first.click();
    await expect.poll(() => editorText(page)).toContain(name);
  });

  test("open full page goes to the catalog page for that object", async ({ page }) => {
    await (await reveal(page, "slow_rows")).click();
    await page.getByTestId("inspector-open-full").click();
    await expect(page.getByTestId("sql-editor-view")).toBeHidden();
    await expect(page.locator("main")).toContainText("slow_rows", { timeout: T_NORMAL });
  });

  test("hover and keyboard focus preview a function's signature", async ({ page }) => {
    const item = await reveal(page, "slow_rows");
    await item.hover();
    const card = page.getByTestId("tree-hover-card");
    await expect(card).toBeVisible({ timeout: T_NORMAL });
    await expect(card).toContainText("slow_rows(rows");
    await expect(card).toContainText("to insert");
    await page.mouse.move(900, 600);
    await expect(card).toBeHidden();

    await item.focus();
    await expect(card).toBeVisible();
    await expect(item).toHaveAttribute("aria-describedby", "tree-hover-card");
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
  });

  test("the insert button writes a call with tab-stop arguments", async ({ page }) => {
    const item = await reveal(page, "slow_rows");
    await item.hover();
    await item.getByTestId("tree-insert").click();
    await expect.poll(() => editorText(page)).toBe("SELECT * FROM cupola_test.edge.slow_rows(rows, delay_ms)");
    // The first argument is selected; typing replaces it, Tab moves on.
    await page.keyboard.type("5");
    await page.keyboard.press("Tab");
    await page.keyboard.type("0");
    await expect.poll(() => editorText(page)).toBe("SELECT * FROM cupola_test.edge.slow_rows(5, 0)");
  });

  test("modifier-click inserts a bare call into existing SQL", async ({ page }) => {
    await typeInEditor(page, "SELECT * FROM ");
    const item = await reveal(page, "slow_rows");
    await item.click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(() => editorText(page)).toBe("SELECT * FROM cupola_test.edge.slow_rows(rows, delay_ms)");
  });

  test("signature help follows the argument being typed, and hover describes the function", async ({ page }) => {
    await typeInEditor(page, "SELECT * FROM cupola_test.edge.slow_rows(1, ");
    const help = page.getByTestId("editor-signature-help");
    await expect(help).toBeVisible({ timeout: T_NORMAL });
    await expect(help.locator(".cm-vgi-sig-active")).toContainText("delay_ms");
    // Escape closes an open completion list first, then the signature help.
    if (await page.locator(".cm-tooltip-autocomplete").isVisible()) {
      await page.keyboard.press("Escape");
      await expect(page.locator(".cm-tooltip-autocomplete")).toBeHidden();
    }
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    // It stays dismissed while the cursor is in the same call.
    await page.keyboard.type("0");
    await expect(help).toBeHidden();

    await page.keyboard.type(")");
    // Hover the function name itself (the line element is wider than its text).
    const box = await page.evaluate(() => {
      const content = document.querySelector(".cm-content")!;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf("slow_rows");
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i + 2);
        range.setEnd(n, i + 3);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    });
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x, box!.y);
    await expect(page.getByTestId("editor-function-hover")).toBeVisible({ timeout: T_NORMAL });
    await expect(page.getByTestId("editor-function-hover")).toContainText("cupola_test.edge");
  });

  test("DuckDB built-ins get signature help, long option lists folded", async ({ page }) => {
    await typeInEditor(page, "SELECT strftime(current_date, ");
    const help = page.getByTestId("editor-signature-help");
    await expect(help).toBeVisible({ timeout: T_NORMAL });
    await expect(help.locator(".cm-vgi-sig-active")).toContainText("format");
    await expect(help).toContainText("DuckDB built-in function");

    await typeInEditor(page, "SELECT * FROM read_csv('data.csv', header := ");
    await expect(help).toBeVisible({ timeout: T_NORMAL });
    await expect(help.locator(".cm-vgi-sig-active")).toContainText("header");
    await expect(help).toContainText("named options");
  });

  test("a memory macro inserts as a scalar call", async ({ page }) => {
    await page.waitForFunction(() => typeof (window as any).__bridge?.refreshMemoryTables === "function", null, { timeout: T_SHELL_BOOT });
    const created = await page.evaluate(async () => {
      const bridge = (window as any).__bridge;
      const r = await bridge.query("CREATE OR REPLACE MACRO memory.main.pw_add(a, b) AS a + b");
      await bridge.refreshMemoryTables();
      return r.ok ? null : r.error;
    });
    expect(created).toBeNull();
    const item = await reveal(page, "pw_add");
    await item.hover();
    await item.getByTestId("tree-insert").click();
    await expect.poll(() => editorText(page)).toBe("SELECT memory.main.pw_add(a, b)");
    await item.click();
    await expect(page.getByTestId("inspector-callable")).toContainText("scalar macro");
    await page.evaluate(async () => {
      const bridge = (window as any).__bridge;
      await bridge.query("DROP MACRO IF EXISTS memory.main.pw_add");
      await bridge.refreshMemoryTables();
    });
  });

  test("a view's SQL definition is available on request, and sections are ruled off", async ({ page }) => {
    await page.waitForFunction(() => typeof (window as any).__bridge?.refreshMemoryTables === "function", null, { timeout: T_SHELL_BOOT });
    const created = await page.evaluate(async () => {
      const bridge = (window as any).__bridge;
      const r = await bridge.query("CREATE OR REPLACE VIEW memory.main.pw_inspect_view AS SELECT 1 AS answer, 'x' AS label");
      await bridge.refreshMemoryTables();
      return r.ok ? null : r.error;
    });
    expect(created).toBeNull();
    try {
      await page.evaluate(() => localStorage.removeItem("cupola.inspector.view-sql-open"));
      await (await reveal(page, "pw_inspect_view")).click();
      const inspector = page.getByTestId("editor-inspector");
      await expect(inspector.getByRole("heading", { name: /Columns/ })).toBeVisible({ timeout: T_NORMAL });

      // Collapsed by default; opening shows the definition and is remembered.
      const sql = page.getByTestId("inspector-view-sql");
      await expect(sql).toBeVisible();
      await expect(sql.locator("pre")).toHaveCount(0);
      await page.getByTestId("inspector-view-sql-toggle").click();
      await expect(sql.locator("pre")).toContainText("answer");
      expect(await page.evaluate(() => localStorage.getItem("cupola.inspector.view-sql-open"))).toBe("1");
    } finally {
      await page.evaluate(async () => {
        const bridge = (window as any).__bridge;
        await bridge.query("DROP VIEW IF EXISTS memory.main.pw_inspect_view");
        await bridge.refreshMemoryTables();
      });
    }
  });

  test("Ask AI and the Inspector share one panel", async ({ page }) => {
    await page.getByTestId("editor-ask-ai").click();
    await expect(page.getByTestId("editor-ai-panel")).toBeVisible();
    await (await reveal(page, "slow_rows")).click();
    await expect(page.getByTestId("editor-inspector")).toBeVisible();
    await expect(page.getByTestId("editor-ai-panel")).toBeHidden();
    await expect(page.getByTestId("editor-ask-ai")).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("dock-tab-ai").click();
    await expect(page.getByTestId("editor-ai-panel")).toBeVisible();
    await page.getByTestId("dock-close").click();
    await expect(page.getByTestId("editor-dock")).toBeHidden();
  });
});
