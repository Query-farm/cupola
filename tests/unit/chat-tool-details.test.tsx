import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatMessageAssistant, type ContentBlock } from "../../src/components/chat/ChatMessageAssistant";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe("agent tool-call details", () => {
  test("expands a report query to show its SQL and result", () => {
    const blocks: ContentBlock[] = [{
      type: "tool_call",
      id: "preview-weather",
      toolCall: {
        name: "preview_sql",
        input: { sql: "SELECT temperature FROM weather ORDER BY observed_at" },
        result: "Query returned 24 rows.",
        isExecuting: false,
      },
    }];
    const { getByTestId, getByText } = render(<ChatMessageAssistant blocks={blocks} />);
    const details = getByTestId("tool-call-details-preview_sql") as HTMLDetailsElement;

    expect(details.open).toBe(false);
    fireEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(true);
    expect(getByText("SELECT temperature FROM weather ORDER BY observed_at")).toBeTruthy();
    expect(getByText("Query returned 24 rows.")).toBeTruthy();
  });

  test("shows structured report-tool arguments and failure details", () => {
    const blocks: ContentBlock[] = [{
      type: "tool_call",
      id: "dataset-weather",
      toolCall: {
        name: "upsert_report_dataset",
        input: { dataset: { id: "weather", name: "Weather", sql: "SELECT * FROM weather" } },
        error: "Column observed_at was not found.",
        isExecuting: false,
      },
    }];
    const { getByTestId, getByText } = render(<ChatMessageAssistant blocks={blocks} />);
    const details = getByTestId("tool-call-details-upsert_report_dataset") as HTMLDetailsElement;

    fireEvent.click(details.querySelector("summary")!);
    expect(details.textContent).toContain('"name": "Weather"');
    expect(details.textContent).toContain('"sql": "SELECT * FROM weather"');
    expect(getByText("Column observed_at was not found.")).toBeTruthy();
    expect(details.querySelector("summary")?.textContent).toContain("failed");
  });
});
