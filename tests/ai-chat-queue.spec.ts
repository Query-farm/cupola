/**
 * Messages typed while an agent works, in the data chat (Ask AI tab) and the Query Editor's
 * Ask AI panel: delivered after the agent's next tool round, sent as the next turn when it
 * finishes first, and handed back to the composer on Stop. The report agent's equivalent is in
 * evidence-agent.spec.ts.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { gotoApp, openEditor, waitForShellBridge } from "./helpers";

function stream(tool?: { name: string; input: unknown }, text = "Answered.") {
  const events = [
    { type: "message_start", message: { id: "mock-message", usage: { input_tokens: 100 } } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: `tool-${Math.random()}`, name: tool.name } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Requests 1, 2 and 3 wait for the test to release them; 4 never answers, for the Stop case. */
async function mockAnthropic(page: Page) {
  const requests: any[] = [];
  const gates: (() => void)[] = [];
  const replies = [stream({ name: "run_sql", input: { sql: "SELECT 1 AS one" } }), stream(undefined, "First answer."), stream(undefined, "Second answer."), stream(undefined, "Third answer.")];
  await page.route("https://api.anthropic.com/v1/messages", async (route) => {
    const index = requests.push(route.request().postDataJSON()) - 1;
    if (index === 4) return new Promise(() => {});
    if (index === 0 || index === 2) await new Promise<void>((resolve) => { gates[index] = resolve; });
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: replies[index] });
  });
  return { requests, release: (index: number) => expect.poll(() => typeof gates[index]).toBe("function").then(() => gates[index]()) };
}

async function exercise(panel: Locator, mock: Awaited<ReturnType<typeof mockAnthropic>>) {
  const { requests, release } = mock;
  const input = panel.getByRole("textbox", { name: "Chat message input" });

  // Mid-turn: the agent is about to run a query, so the follow-up rides with its result.
  await input.fill("How many rows?"); await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  await input.fill("Use Celsius"); await input.press("Enter");
  await expect(panel.getByText("Queued · the agent reads this after its current step")).toBeVisible();
  await expect(input).toHaveValue("");
  await release(0);
  await expect.poll(() => requests.length).toBe(2);
  const delivered = requests[1].messages.at(-1).content;
  expect(delivered[0].type).toBe("tool_result");
  expect(delivered.at(-1).type).toBe("text");
  expect(delivered.at(-1).text).toContain("Use Celsius");
  await expect(panel.getByText("First answer.")).toBeVisible();
  await expect(panel.getByText("Queued", { exact: false })).toHaveCount(0);
  // The reply to the follow-up reads below it.
  const followUp = await panel.getByText("Use Celsius", { exact: true }).boundingBox();
  const reply = await panel.getByText("First answer.").boundingBox();
  expect(followUp!.y).toBeLessThan(reply!.y);

  // The agent finishes without another tool call: the queued message becomes the next turn.
  await input.fill("Add a chart"); await input.press("Enter");
  await expect.poll(() => requests.length).toBe(3);
  await input.fill("And a table"); await input.press("Enter");
  await release(2);
  await expect.poll(() => requests.length).toBe(4);
  expect(JSON.stringify(requests[3].messages.at(-1).content)).toContain("And a table");
  await expect(panel.getByText("And a table", { exact: true })).toHaveCount(1);
  await expect(panel.getByText("Third answer.")).toBeVisible();

  // Stop hands what the agent never took back to the composer.
  await input.fill("Slow question"); await input.press("Enter");
  await expect.poll(() => requests.length).toBe(5);
  await input.fill("Use metres"); await input.press("Enter");
  await expect(panel.getByText("Use metres", { exact: true })).toBeVisible();
  await input.fill("please");
  await panel.getByRole("button", { name: "Stop generation" }).click();
  await expect(input).toHaveValue("Use metres\n\nplease");
  await expect(panel.getByText("Use metres", { exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(5);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vgi-frontend-settings", JSON.stringify({ anthropicApiKey: "test-key-not-real", aiModel: "claude-sonnet-4-6", aiQueryMode: "unrestricted-sql" })));
});

test("Ask AI takes messages sent while it works", async ({ page }) => {
  const mock = await mockAnthropic(page);
  await gotoApp(page);
  await waitForShellBridge(page);
  await page.getByTestId("tab-askai").click();
  await exercise(page.locator("body"), mock);
});

test("the editor's Ask AI panel takes messages sent while it works", async ({ page }) => {
  const mock = await mockAnthropic(page);
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
  await page.getByTestId("editor-ask-ai").click();
  await exercise(page.getByTestId("editor-ai-panel"), mock);
});
