import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ReportSparkline } from "../../src/components/reports/ReportSparkline";
import type { ReportSparklineBlock } from "../../src/lib/reports/types";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const block: ReportSparklineBlock = {
  id: "forecast",
  type: "sparkline",
  title: "Humidity forecast",
  datasetId: "weather",
  valueColumn: "humidity",
  splitColumn: "is_forecast",
  splitLabel: "Now",
  splitColor: "#7c3aed",
  color: "#0f8b75",
  layout: { x: 0, y: 0, w: 3, h: 2 },
};

describe("report sparkline split", () => {
  test("renders a labeled divider and clipped second color", () => {
    const { getByTestId, container } = render(<ReportSparkline
      block={block}
      rows={[
        { humidity: 70, is_forecast: false },
        { humidity: 68, is_forecast: false },
        { humidity: 66, is_forecast: true },
        { humidity: 65, is_forecast: true },
      ]}
      formatValue={(value) => String(value)}
    />);

    const divider = getByTestId("report-sparkline-split");
    expect(divider.getAttribute("x1")).toBe("50");
    expect(divider.getAttribute("aria-label")).toBe("Now");
    expect(container.querySelectorAll("clipPath")).toHaveLength(2);
    expect(container.innerHTML).toContain("#7c3aed");
    expect(getByTestId("report-sparkline-value").textContent).toBe("68");
    expect(getByTestId("report-sparkline-headline-point").getAttribute("x1")).toBe("33.33");
  });
});
