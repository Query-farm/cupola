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

/** Navigate to the app and wait for the sidebar tree to render. The engine
 *  host is mounted for the whole session, so the DuckDB bridge boots on load
 *  regardless of the active tab. */
export async function gotoApp(page: Page): Promise<void> {
  // No init script: the app defaults to the Catalog tab, and the engine host
  // boots on load regardless of tab. (Forcing a tab here would run on every
  // navigation incl. reloads and clobber persistence specs.)
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

/** Switch to the SQL Shell tab. Idempotent. */
export async function openShell(page: Page): Promise<void> {
  await page.getByTestId("tab-shell").click();
  await expect(page.getByTestId("tab-shell")).toHaveAttribute("aria-selected", "true", { timeout: T_NORMAL });
}

/** Switch to the SQL editor tab and wait for it to mount. */
export async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("tab-editor").click();
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
