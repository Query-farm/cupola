/**
 * Shared helpers and constants for VGI Web Frontend Playwright tests.
 *
 * Requires:
 *   - Dev server on localhost:4321 (auto-started by playwright config)
 *   - VGI server (vgi-volcanos, no-auth) on localhost:9009
 */
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const BASE = `/v${pkg.version}/`;
// Override with VGI_SERVICE_URL to point the suite at a different VGI server
// (e.g. a hosted haybarn-backed instance) without editing the suite.
export const SERVICE_URL = process.env.VGI_SERVICE_URL || "http://localhost:9009";
export const APP_URL = `http://localhost:4321${BASE}?service=${encodeURIComponent(SERVICE_URL)}`;

// Tight timeouts: prefer fast failure over hanging. The real wait is the very
// first page load (DuckDB-WASM + catalog fetch) handled in gotoApp().
export const T_FAST = 2_000;
export const T_NORMAL = 5_000;
export const T_SHELL_BOOT = 20_000;

/** Navigate to the app and wait for the sidebar tree to render. */
export async function gotoApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      // Force shell into "panel" mode so DuckDBShell mounts and wires up the
      // bridge — minimized mode defers terminal/worker init.
      localStorage.setItem("vgi-shell-mode", "panel");
    } catch {}
  });
  await page.goto(APP_URL);
  await page.getByRole("tree").first().waitFor({ state: "visible", timeout: T_SHELL_BOOT });
}

/** Wait for the DuckDB-WASM bridge to be ready. */
export async function waitForShellBridge(page: Page, timeoutMs = T_SHELL_BOOT): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as any).__bridge?.runQuery === "function",
    null,
    { timeout: timeoutMs },
  );
}

/** Idempotently open the shell panel. Safe to call when already open. */
export async function openShell(page: Page): Promise<void> {
  const minimize = page.getByRole("button", { name: "Minimize shell panel" });
  if (await minimize.isVisible({ timeout: 200 }).catch(() => false)) return;
  const expandBtn = page.getByRole("button", { name: "Expand shell panel" });
  if (await expandBtn.isVisible({ timeout: 200 }).catch(() => false)) {
    await expandBtn.click();
  } else {
    await page.locator("aside, div").getByRole("button", { name: /^SQL Shell$/ }).first().click();
  }
  await expect(minimize).toBeVisible({ timeout: T_NORMAL });
}

/** Switch to the full-page SQL editor surface and wait for it to mount. */
export async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("view-toggle-editor").click();
  await page.getByTestId("sql-editor-view").waitFor({ state: "visible", timeout: T_NORMAL });
}

/** Type SQL into the active CodeMirror editor (replacing existing content). */
export async function typeInEditor(page: Page, sql: string): Promise<void> {
  const content = page.locator(".cm-content").first();
  await content.click();
  // Select-all + delete so the editor starts clean, then type.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await content.pressSequentially(sql);
}

/**
 * Run a SQL query directly against the DuckDB-WASM worker via bridge.query
 * and decode the Arrow IPC result into JS rows.
 */
export async function shellQuery(
  page: Page,
  sql: string,
): Promise<{
  ok: boolean;
  error?: string;
  numRows?: number;
  columns?: string[];
  rows?: Record<string, any>[];
}> {
  return page.evaluate(async (sql) => {
    const bridge = (window as any).__bridge;
    if (!bridge?.query) throw new Error("bridge.query not available");
    const result = await bridge.query(sql);
    if (!result.ok) return { ok: false, error: result.error };
    if (!result.arrowBuffers?.length) return { ok: true, numRows: 0, columns: [], rows: [] };
    const { tableFromIPC } = await import("/node_modules/apache-arrow/Arrow.mjs");
    const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
    const fields = table.schema.fields;
    const columns = fields.map((f: any) => f.name);
    const rows: Record<string, any>[] = [];
    for (let r = 0; r < table.numRows; r++) {
      const row: Record<string, any> = {};
      for (let c = 0; c < fields.length; c++) {
        const v = table.getChildAt(c)?.get(r);
        row[columns[c]] = v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : v;
      }
      rows.push(row);
    }
    return { ok: true, numRows: table.numRows, columns, rows };
  }, sql);
}
