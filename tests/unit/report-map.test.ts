import { describe, expect, test } from "bun:test";
import { buildReportMapFeatures, reportMapColorMap } from "../../src/lib/reports/map";
import type { ReportMapBlock } from "../../src/lib/reports/types";

const baseBlock: ReportMapBlock = {
  id: "map",
  type: "map",
  datasetId: "locations",
  latitudeColumn: "latitude",
  longitudeColumn: "longitude",
  colorColumn: "region",
  layout: { x: 0, y: 0, w: 12, h: 6 },
};

function pointWkb(longitude: number, latitude: number): Uint8Array {
  const bytes = new Uint8Array(21);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 1, true);
  view.setFloat64(5, longitude, true);
  view.setFloat64(13, latitude, true);
  return bytes;
}

describe("report map data", () => {
  test("creates point features and skips invalid coordinates", () => {
    const result = buildReportMapFeatures([
      { name: "New York", latitude: 40.7128, longitude: -74.006, region: "East" },
      { name: "Invalid", latitude: 120, longitude: -74, region: "East" },
      { name: "Missing", latitude: null, longitude: null, region: "West" },
    ], baseBlock);

    expect(result.skipped).toBe(2);
    expect(result.features).toHaveLength(1);
    expect(result.features[0].geometry).toEqual({ type: "Point", coordinates: [-74.006, 40.7128] });
    expect(result.features[0].properties.name).toBe("New York");
  });

  test("converts WKB geometry columns", () => {
    const result = buildReportMapFeatures(
      [{ name: "London", geometry: pointWkb(-0.1276, 51.5072) }],
      { ...baseBlock, geometryColumn: "geometry", latitudeColumn: undefined, longitudeColumn: undefined },
    );

    expect(result.skipped).toBe(0);
    expect(result.features[0].geometry).toEqual({ type: "Point", coordinates: [-0.1276, 51.5072] });
  });

  test("assigns stable categorical colors", () => {
    const colors = reportMapColorMap([
      { region: "East" }, { region: "West" }, { region: "East" },
    ], { ...baseBlock, palette: ["red", "blue"] });

    expect([...colors]).toEqual([["East", "red"], ["West", "blue"]]);
  });
});
