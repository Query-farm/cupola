/**
 * Every surface that runs a query cancels it the same way: it passes an
 * AbortSignal to engine.query and aborts it. The editor's Stop is covered in
 * editor-cancel.spec.ts; these are the shell's Ctrl+C and Stop in the two AI
 * chats, which used to cancel nothing in the engine: the shell had no cancel at
 * all, and the chats only rejected the tool's promise while the scan ran on and
 * held up the next query.
 *
 * Fixture: `cupola_test.edge.slow_rows(100000, 2000)` sleeps 2s on the server
 * per 1,000-row chunk (about 200s in all). A cancel that only hides the
 * spinner leaves the engine finishing the scan, so the follow-up query's bound
 * is what tells a real cancel from a cosmetic one.
 *
 * Requires `test-worker/run.sh`; skips without the `cupola_test` catalog, or on
 * an engine that can't interrupt a running query.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { gotoApp, openEditor, openShell, shellQuery, waitForShellBridge, T_NORMAL } from "./helpers";

const DELAY_MS = 2_000;
const SLOW_SQL = `SELECT count(*) AS n FROM cupola_test.edge.slow_rows(100000, ${DELAY_MS})`;

async function requireCancellableEngine(page: Page): Promise<void> {
  const catalog = await shellQuery(page, "SELECT DISTINCT catalog_name FROM information_schema.schemata WHERE catalog_name = 'cupola_test'");
  test.skip(!catalog.rows?.length, "cupola_test is not attached — start test-worker/run.sh");
  const interrupts = await page.evaluate(() => (window as any).__bridge.interruptsRunningQueries);
  test.skip(!interrupts, "needs a haybarn-wasm build with getInterruptHandle (threads build)");
}

/** The engine is free: a trivial query finishes well inside one more server chunk. */
async function expectEngineFree(page: Page): Promise<void> {
  const elapsed = await page.evaluate(async () => {
    const started = performance.now();
    const result = await (window as any).__bridge.query("SELECT 4242 AS after_cancel");
    if (!result.ok) throw new Error(result.error);
    return performance.now() - started;
  });
  expect(elapsed).toBeLessThan(DELAY_MS * 2);
}

function stream(tool?: { name: string; input: unknown }, text = "Done.") {
  const events = [
    { type: "message_start", message: { id: "mock-message", usage: { input_tokens: 100 } } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "tool-slow", name: tool.name } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** The agent's first reply runs the slow scan; anything after that ends the turn. */
async function mockAgentRunningSlowSql(page: Page): Promise<void> {
  let calls = 0;
  await page.route("https://api.anthropic.com/v1/messages", async (route) => {
    const body = calls++ === 0 ? stream({ name: "run_sql", input: { sql: SLOW_SQL } }) : stream();
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
}

async function stopAgentMidQuery(page: Page, panel: Locator): Promise<void> {
  const input = panel.getByRole("textbox", { name: "Chat message input" });
  await input.fill("Count the slow rows");
  await input.press("Enter");
  const stop = panel.getByRole("button", { name: "Stop generation" });
  await expect(stop).toBeVisible({ timeout: T_NORMAL });
  // Into the scan's chunk loop, with a chunk request in flight.
  await page.waitForTimeout(DELAY_MS + 500);
  await stop.click();
  await expect(stop).toBeHidden({ timeout: T_NORMAL });
}

test.describe("AI chats", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("vgi-frontend-settings", JSON.stringify({ anthropicApiKey: "test-key-not-real", aiModel: "claude-sonnet-4-6", aiQueryMode: "unrestricted-sql" })));
  });

  test("Stop in Ask AI cancels the agent's running query", async ({ page }) => {
    test.setTimeout(60_000);
    await mockAgentRunningSlowSql(page);
    await gotoApp(page);
    await waitForShellBridge(page);
    await requireCancellableEngine(page);
    await page.getByTestId("tab-askai").click();
    await stopAgentMidQuery(page, page.locator("body"));
    await expectEngineFree(page);
  });

  test("Stop in the editor's Ask AI panel cancels the agent's running query", async ({ page }) => {
    test.setTimeout(60_000);
    await mockAgentRunningSlowSql(page);
    await gotoApp(page);
    await waitForShellBridge(page);
    await requireCancellableEngine(page);
    await openEditor(page);
    await page.getByTestId("editor-ask-ai").click();
    await stopAgentMidQuery(page, page.getByTestId("editor-ai-panel"));
    await expectEngineFree(page);
  });
});

test("Ctrl+C in the shell cancels the running query", async ({ page }) => {
  test.setTimeout(60_000);
  await gotoApp(page);
  await waitForShellBridge(page);
  await requireCancellableEngine(page);
  await openShell(page);
  await page.evaluate(() => (window as any).__bridge.attached);
  await page.evaluate((sql) => (window as any).__bridge.runQuery(sql), SLOW_SQL);
  await page.waitForTimeout(DELAY_MS + 500);
  await page.locator(".xterm").first().click();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => {
      const buffer = (window as any).__bridge.shellTerm.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        if ((buffer.getLine(i)?.translateToString(true) ?? "").includes("Query cancelled.")) return true;
      }
      return false;
    }), { timeout: T_NORMAL })
    .toBe(true);
  await expectEngineFree(page);
});
