/**
 * Unit tests for geometry handling in sanitizeRowsForVega.
 *
 * Vega-Lite's geoshape mark only renders geometry that arrives as GeoJSON
 * Feature/geometry data values — NOT geometry sitting in a tabular field. So
 * when a query result carries a geometry column, the chart pipeline must
 * reshape rows into Features (geometry + properties). These tests lock that in
 * and guard that non-geometry results are left as plain rows.
 */
import { test, expect, describe } from "bun:test";
import { sanitizeRowsForVega } from "../../src/components/chat/chart-embed";

/** Little-endian WKB POINT(x y). */
function wkbPoint(x: number, y: number): Uint8Array {
  const buf = new ArrayBuffer(21);
  const dv = new DataView(buf);
  dv.setUint8(0, 1); dv.setUint32(1, 1, true); dv.setFloat64(5, x, true); dv.setFloat64(13, y, true);
  return new Uint8Array(buf);
}

describe("sanitizeRowsForVega geometry handling", () => {
  test("WKB geometry column → GeoJSON Feature with other columns as properties", () => {
    const out = sanitizeRowsForVega([{ geom: wkbPoint(-100, 45), name: "A", pop: 12 }]);
    expect(out[0].type).toBe("Feature");
    expect(out[0].geometry).toEqual({ type: "Point", coordinates: [-100, 45] });
    expect(out[0].properties).toEqual({ name: "A", pop: 12 });
    // The geometry must NOT remain as a tabular field (that wouldn't render).
    expect(out[0].geom).toBeUndefined();
  });

  test("plain non-geometry rows are left as tabular rows", () => {
    const out = sanitizeRowsForVega([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(out).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(out[0].type).toBeUndefined();
  });

  test("already-parsed GeoJSON geometry objects are wrapped too", () => {
    const out = sanitizeRowsForVega([{ shape: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,0]]] }, label: "z" }]);
    expect(out[0].type).toBe("Feature");
    expect(out[0].geometry.type).toBe("Polygon");
    expect(out[0].properties).toEqual({ label: "z" });
  });
});
