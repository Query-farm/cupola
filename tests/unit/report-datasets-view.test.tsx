import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { tableFromArrays } from "@query-farm/apache-arrow";
import { ReportDatasetsView } from "../../src/components/reports/ReportDatasetsView";
import type { ReportDocumentV1 } from "../../src/lib/reports/types";
import type { CatalogData } from "../../src/lib/service";

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

const governedCatalog: CatalogData = {
  catalogName: "weather",
  catalogComment: null,
  catalogTags: { "vgi.semantic_catalog": JSON.stringify({ catalog_id: "farm.query.weather" }) },
  defaultSchema: "main",
  schemas: [{
    info: { name: "main", comment: null, tags: {} } as any,
    tables: [], views: [], macros: [],
    functions: [{
      name: "forecast",
      schema_name: "main",
      function_type: "TABLE",
      input_from_args: false,
      _functionArgsDetailed: true,
      _functionArgs: [{ name: "temperature_unit", arrowType: "VARCHAR", duckdbType: "VARCHAR", nullable: true, named: true, positional: false, fieldIndex: 0, isTableInput: false, isAnyType: false, isVarargs: false, isConst: false, defaultValue: "celsius", choices: ["celsius", "fahrenheit"] }],
      _functionReturn: { isTable: true, columns: [{ name: "location_id", arrowType: "VARCHAR", duckdbType: "VARCHAR", nullable: false }, { name: "temperature", arrowType: "DOUBLE", duckdbType: "DOUBLE", nullable: false }] },
      tags: {
        "vgi.semantic_entity": JSON.stringify({ entity_id: "forecast", grain: ["location_id"], source: { arguments: [{ argument: "temperature_unit", parameter: "temperature_unit" }] } }),
        "vgi.semantic_members": JSON.stringify([{ member_id: "location_id", kind: "identifier", column: "location_id" }, { member_id: "temperature", kind: "dimension", column: "temperature", data_type: "DOUBLE", hidden: true, unit_parameter: { argument: "temperature_unit", values: { celsius: "Cel", fahrenheit: "[degF]" } } }, { member_id: "average_temperature", kind: "measure", title: "Average temperature", aggregation: "avg", member: "temperature", additivity: "non_additive" }]),
      },
    } as any],
  }],
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

  test("surfaces governed units, generated SQL, and model drift", () => {
    const semanticReport: ReportDocumentV1 = {
      ...report,
      datasets: [{
        id: "conditions",
        name: "Average temperature",
        kind: "semantic",
        acceptedModelFingerprint: `sha256:${"1".repeat(64)}`,
        query: { measures: [{ catalog_id: "farm.query.weather", entity_id: "forecast", member_id: "average_temperature" }] },
      }],
      blocks: [],
    };
    const table = tableFromArrays({ average_temperature: [20] });
    const accept = mock(() => {});
    const view = render(<ReportDatasetsView
      report={semanticReport}
      results={{ conditions: {
        table,
        rows: [{ average_temperature: 20 }],
        status: "success",
        semantic: {
          fingerprint: `sha256:${"2".repeat(64)}`,
          modelChanged: true,
          plan: {
            fact_branches: [{ root: { catalog_id: "farm.query.weather", entity_id: "forecast" }, attachment_alias: "weather", entities: ["farm.query.weather::forecast"], invocations: [], effective_source_grain: [], result_grain: [], estimated_invocations: 1, driving_grain_reduced: false }],
            sql: "SELECT avg(temperature) AS average_temperature FROM weather.main.forecast",
            parameters: [],
            validation_scope: "semantic",
            warnings: [],
            output_units: { average_temperature: "Cel" },
          },
        },
      } }}
      appliedValues={{}}
      running={false}
      engineReady
      canEdit
      onRunDataset={() => {}}
      onOpenSql={() => {}}
      onAcceptSemanticModel={accept}
    />);

    expect(view.getByTestId("report-semantic-summary").textContent).toContain("average_temperature");
    expect(view.getByTestId("report-dataset-schema-row-average_temperature").textContent).toContain("Cel");
    expect(view.getByTestId("report-dataset-sql").textContent).toContain("SELECT avg");
    expect(view.getByTestId("report-semantic-model-changed")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Accept current model" }));
    expect(accept).toHaveBeenCalledWith("conditions", `sha256:${"2".repeat(64)}`);
  });

  test("offers guided governed fields, function parameters, and advanced JSON", () => {
    const semanticReport: ReportDocumentV1 = {
      ...report,
      datasets: [{ id: "conditions", name: "Temperature", kind: "semantic", query: { measures: [{ catalog_id: "farm.query.weather", entity_id: "forecast", member_id: "average_temperature" }] } }],
      blocks: [],
    };
    const view = render(<ReportDatasetsView
      report={semanticReport}
      results={{}}
      appliedValues={{}}
      running={false}
      engineReady
      canEdit
      catalogs={[governedCatalog]}
      onRunDataset={() => {}}
      onOpenSql={() => {}}
    />);
    fireEvent.click(view.getByTestId("report-edit-dataset"));
    expect(view.getByTestId("report-semantic-builder").textContent).toContain("Average temperature");
    expect(view.getByText("Function parameters")).toBeTruthy();
    expect(view.getByText(/default celsius/)).toBeTruthy();
    fireEvent.click(view.getByText("Advanced semantic JSON"));
    const editor = view.getByTestId("report-dataset-semantic-editor") as HTMLTextAreaElement;
    expect(editor.value).toContain("average_temperature");
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
