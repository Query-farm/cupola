/**
 * Unit tests for wkbToWKT — DuckDB-style WKT rendering of WKB geometry.
 *
 * Geometry columns arrive as WKB (geoarrow.* tagged binary); the shell must
 * render them as WKT like DuckDB's ST_AsText, not as a hex blob. These tests
 * build little-endian WKB by hand and assert the WKT matches DuckDB's format.
 */
import { test, expect, describe } from "bun:test";
import { wkbToWKT } from "../../src/lib/wkb";

/** Minimal little-endian WKB writer for test fixtures. */
class W {
  private bytes: number[] = [];
  u8(n: number) { this.bytes.push(n & 0xff); return this; }
  u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); this.bytes.push(...b); return this; }
  f64(n: number) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, true); this.bytes.push(...b); return this; }
  raw(u: Uint8Array) { this.bytes.push(...u); return this; }
  done() { return new Uint8Array(this.bytes); }
}
const point = (x: number, y: number) => new W().u8(1).u32(1).f64(x).f64(y).done();
const lineString = (pts: number[][]) => {
  const w = new W().u8(1).u32(2).u32(pts.length);
  for (const [x, y] of pts) w.f64(x).f64(y);
  return w.done();
};
const polygon = (rings: number[][][]) => {
  const w = new W().u8(1).u32(3).u32(rings.length);
  for (const ring of rings) { w.u32(ring.length); for (const [x, y] of ring) w.f64(x).f64(y); }
  return w.done();
};

describe("wkbToWKT", () => {
  test("Point", () => {
    expect(wkbToWKT(point(-78.4, 38.02))).toBe("POINT (-78.4 38.02)");
  });

  test("Point with integral coords prints no trailing zeros", () => {
    expect(wkbToWKT(point(1, 2))).toBe("POINT (1 2)");
  });

  test("LineString", () => {
    expect(wkbToWKT(lineString([[0, 0], [1, 1], [2, 3]]))).toBe("LINESTRING (0 0, 1 1, 2 3)");
  });

  test("Polygon with a hole — double parens, comma-separated rings", () => {
    const wkt = wkbToWKT(polygon([
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [2, 1], [2, 2], [1, 1]],
    ]));
    expect(wkt).toBe("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 1))");
  });

  test("MultiPoint — DuckDB style, no per-point parens", () => {
    const w = new W().u8(1).u32(4).u32(2).raw(point(1, 2)).raw(point(3, 4)).done();
    expect(wkbToWKT(w)).toBe("MULTIPOINT (1 2, 3 4)");
  });

  test("MultiPolygon — triple parens", () => {
    const w = new W().u8(1).u32(6).u32(2)
      .raw(polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]))
      .raw(polygon([[[5, 5], [6, 5], [6, 6], [5, 5]]]))
      .done();
    expect(wkbToWKT(w)).toBe("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))");
  });

  test("big-endian byte order is honored", () => {
    const buf = new ArrayBuffer(1 + 4 + 16);
    const dv = new DataView(buf);
    dv.setUint8(0, 0);            // big-endian flag
    dv.setUint32(1, 1, false);   // type = point, BE
    dv.setFloat64(5, 10, false);
    dv.setFloat64(13, 20, false);
    expect(wkbToWKT(new Uint8Array(buf))).toBe("POINT (10 20)");
  });
});
