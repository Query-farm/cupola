import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { tableFromArrays } from "@query-farm/apache-arrow";
import { ReportDatasetsView } from "../../src/components/reports/ReportDatasetsView";
import type { ReportDocumentV1 } from "../../src/lib/reports/types";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const report: ReportDocumentV1 = {
  schemaVersion: 1,
  id: "debuggable-report",
  title: "Debuggable report",
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  requiredSources: [],
  parameters: [{ id: "city", key: "city", label: "City", type: "text", defaultValue: "Glen Allen" }],
  datasets: [
    { id: "conditions", name: "Current conditions", description: "Shared by two blocks", sql: "SELECT $city AS city" },
    { id: "choices", name: "City choices", role: "parameter_options", sql: "SELECT 'Glen Allen' AS city" },
  ],
  blocks: [
    { id: "city-kpi", type: "kpi", datasetId: "conditions", title: "Selected city", valueColumn: "city", layout: { x: 0, y: 0, w: 4, h: 2 } },
    { id: "city-table", type: "table", datasetId: "conditions", title: "Conditions", layout: { x: 4, y: 0, w: 8, h: 3 } },
  ],
};

describe("report dataset browser", () => {
  test("shows compiled SQL and consumers without running a query on mount", () => {
    const runDataset = mock(() => {});
    const openSql = mock(() => {});
    const view = render(<ReportDatasetsView
      report={report}
      results={{}}
      appliedValues={{ city: "Norfolk" }}
      running={false}
      engineReady
      onRunDataset={runDataset}
      onOpenSql={openSql}
    />);

    expect(runDataset).toHaveBeenCalledTimes(0);
    expect(view.getByRole("heading", { name: "Current conditions" })).toBeTruthy();
    expect(view.getByTestId("report-dataset-sql").textContent).toContain("SELECT ? AS city");
    expect(view.getByTestId("report-dataset-param-1").textContent).toBe("Parameter 1 = Norfolk");
    expect(view.getByText(/Selected city/)).toBeTruthy();
    expect(view.getByText(/Conditions/)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Run dataset" }));
    expect(runDataset).toHaveBeenCalledWith("conditions");
    fireEvent.click(view.getByRole("button", { name: "Open SQL" }));
    expect(openSql).toHaveBeenCalledWith("conditions");
  });

  test("labels auxiliary datasets and their lack of block consumers", () => {
    const view = render(<ReportDatasetsView
      report={report}
      results={{}}
      appliedValues={{ city: "Glen Allen" }}
      running={false}
      engineReady
      onRunDataset={() => {}}
      onOpenSql={() => {}}
    />);

    fireEvent.click(view.getByTestId("report-dataset-item-choices"));
    expect(view.getAllByText("Parameter options").length).toBeGreaterThan(0);
    expect(view.getByText("No report blocks currently reference this dataset.")).toBeTruthy();
  });

  test("presents result schemas as a table using DuckDB type names", () => {
    const table = tableFromArrays({ city: ["Norfolk"], humidity: [68] });
    const view = render(<ReportDatasetsView
      report={report}
      results={{ conditions: { table, rows: [{ city: "Norfolk", humidity: 68 }], status: "success" } }}
      appliedValues={{ city: "Norfolk" }}
      running={false}
      engineReady
      onRunDataset={() => {}}
      onOpenSql={() => {}}
    />);

    const schema = view.getByTestId("report-dataset-schema");
    expect(schema.textContent).toContain("DuckDB type");
    const city = view.getByTestId("report-dataset-schema-row-city");
    expect(city.textContent).toContain("VARCHAR");
    expect(city.textContent).not.toContain("Utf8");
    const humidity = view.getByTestId("report-dataset-schema-row-humidity");
    expect(humidity.textContent).toContain("DOUBLE");
    expect(humidity.textContent).not.toContain("Float64");
  });
});
