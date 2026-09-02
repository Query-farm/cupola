import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ChatMessageAssistant, type ContentBlock } from "../../src/components/chat/ChatMessageAssistant";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe("agent Markdown table copy", () => {
  test("offers a copy action for ad hoc tables and copies TSV fallback", async () => {
    const writeText = mock(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const blocks: ContentBlock[] = [{
      type: "text",
      id: "forecast",
      content: "| City | High |\n| --- | ---: |\n| Richmond | 87 |",
    }];

    const { getByRole } = render(<ChatMessageAssistant blocks={blocks} />);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Copy table" }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("City\tHigh\nRichmond\t87");
    expect(getByRole("button", { name: "Table copied" })).toBeTruthy();
  });
});
