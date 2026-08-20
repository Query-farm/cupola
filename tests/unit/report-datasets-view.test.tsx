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

  test("only enables dataset deletion when no report block uses it", () => {
    const onDeleteDataset = mock(() => {});
    const view = render(<ReportDatasetsView
      report={report}
      results={{}}
      appliedValues={{ city: "Glen Allen" }}
      running={false}
      engineReady
      canEdit
      onRunDataset={() => {}}
      onOpenSql={() => {}}
      onDeleteDataset={onDeleteDataset}
    />);

    const usedDelete = view.getByTestId("report-delete-dataset") as HTMLButtonElement;
    expect(usedDelete.disabled).toBe(true);
    expect(usedDelete.title).toContain("Used by 2 report blocks");

    fireEvent.click(view.getByTestId("report-dataset-item-choices"));
    const unusedDelete = view.getByTestId("report-delete-dataset") as HTMLButtonElement;
    expect(unusedDelete.disabled).toBe(false);
    const originalConfirm = window.confirm;
    window.confirm = mock(() => true);
    try {
      fireEvent.click(unusedDelete);
      expect(onDeleteDataset).toHaveBeenCalledWith("choices");
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("makes the editable query template visually distinct", () => {
    const view = render(<ReportDatasetsView
      report={report}
      results={{}}
      appliedValues={{ city: "Glen Allen" }}
      running={false}
      engineReady
      canEdit
      onRunDataset={() => {}}
      onOpenSql={() => {}}
    />);

    fireEvent.click(view.getByTestId("report-edit-dataset"));
    const editor = view.getByTestId("report-dataset-sql-editor");
    expect(editor.className).toContain("bg-white");
    expect(view.getByText(/Editable SQL/)).toBeTruthy();
  });

  test("shows sortable refresh profiling and an interactive dependency graph", () => {
    const conditionsTable = tableFromArrays({ city: ["Norfolk"], humidity: [68] });
    const choicesTable = tableFromArrays({ city: ["Glen Allen", "Norfolk"] });
    const view = render(<ReportDatasetsView
      report={report}
      results={{
        choices: { table: choicesTable, rows: [{ city: "Glen Allen" }, { city: "Norfolk" }], status: "success", durationMs: 20, previousDurationMs: 24, planningMs: 5, waitMs: 50, queryMs: 18, decodeMs: 2, transferBytes: 512, queuedAt: 1_000, startedAt: 1_050, finishedAt: 1_070, runId: 7, dependencies: [] },
        conditions: { table: conditionsTable, rows: [{ city: "Norfolk", humidity: 68 }], status: "success", durationMs: 40, previousDurationMs: 30, planningMs: 5, waitMs: 10, queryMs: 35, decodeMs: 5, transferBytes: 1_024, queuedAt: 1_000, startedAt: 1_010, finishedAt: 1_050, runId: 7, dependencies: ["choices"], materialized: true },
      }}
      appliedValues={{ city: "Norfolk" }}
      running={false}
      engineReady
      onRunDataset={() => {}}
      onOpenSql={() => {}}
    />);

    fireEvent.click(view.getByTestId("report-dataset-profile-tab"));
    const profile = view.getByTestId("report-dataset-profile");
    expect(profile.textContent).toContain("Refresh profile");
    expect(profile.textContent).toContain("70 ms");
    expect(profile.textContent).toContain("1.5 KB");
    expect(view.getByTestId("report-dataset-profile-table").textContent).toContain("Current conditions");
    expect(view.getByTestId("report-dataset-dependency-graph")).toBeTruthy();

    fireEvent.click(view.getByTestId("report-dataset-node-choices"));
    expect(view.getByRole("heading", { name: "City choices" })).toBeTruthy();
    expect(view.getByTestId("report-dataset-details-tab").getAttribute("aria-selected")).toBe("true");
  });
});
