import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ReportKpi } from "../../src/components/reports/ReportKpi";
import type { ReportKpiBlock } from "../../src/lib/reports/types";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const block: ReportKpiBlock = {
  id: "humidity",
  type: "kpi",
  title: "Humidity",
  datasetId: "weather",
  valueColumn: "humidity",
  lowColumn: "preferred_low",
  highColumn: "preferred_high",
  targetColumn: "target",
  rangeLabel: "Preferred range",
  layout: { x: 0, y: 0, w: 3, h: 2 },
};

describe("report KPI range", () => {
  test("keeps the current value prominent and directly labels its context range", () => {
    const { getByTestId, getByText } = render(<ReportKpi
      block={block}
      row={{ humidity: 68, preferred_low: 40, preferred_high: 60, target: 55 }}
      formatValue={(value) => String(value)}
    />);

    expect(getByTestId("report-kpi-value").textContent).toBe("68");
    expect(getByText("Preferred range")).toBeTruthy();
    expect(getByText("40")).toBeTruthy();
    expect(getByText("60")).toBeTruthy();
    expect(getByTestId("report-kpi-range-value").getAttribute("data-outside")).toBe("high");
    expect(getByTestId("report-kpi-range-target").getAttribute("style")).toContain("75%");
  });
});
