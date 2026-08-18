import { expect, test } from "bun:test";
import { validateReportResultColumns } from "../../src/lib/reports/execution";
import { createEmptyReport } from "../../src/lib/reports/types";

test("reports missing map columns after dataset execution", () => {
  const report = createEmptyReport("Locations");
  report.datasets.push({ id: "locations", name: "Locations", sql: "SELECT name, latitude FROM locations" });
  report.blocks.push({
    id: "map",
    type: "map",
    datasetId: "locations",
    title: "Office map",
    latitudeColumn: "latitude",
    longitudeColumn: "longitude",
    labelColumn: "name",
    tooltipColumns: ["name", "status"],
    layout: { x: 0, y: 0, w: 12, h: 6 },
  });

  expect(validateReportResultColumns(report, [{
    datasetId: "locations",
    ok: true,
    columns: ["name", "latitude"],
  }])).toEqual(["Office map: missing result columns longitude, status."]);
});
