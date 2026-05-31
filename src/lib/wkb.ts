/**
 * Minimal WKB (Well-Known Binary) to GeoJSON parser.
 * Supports Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon.
 * Zero dependencies, browser-safe.
 */

type GeoJSONGeometry =
  | { type: "Point"; coordinates: number[] }
  | { type: "LineString"; coordinates: number[][] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPoint"; coordinates: number[][] }
  | { type: "MultiLineString"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: "GeometryCollection"; geometries: GeoJSONGeometry[] };

const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
const WKB_MULTIPOINT = 4;
const WKB_MULTILINESTRING = 5;
const WKB_MULTIPOLYGON = 6;
const WKB_GEOMETRYCOLLECTION = 7;

class WKBReader {
  private view: DataView;
  private offset = 0;
  private littleEndian = true;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  private readByte(): number {
    return this.view.getUint8(this.offset++);
  }

  private readUint32(): number {
    const val = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += 4;
    return val;
  }

  private readFloat64(): number {
    const val = this.view.getFloat64(this.offset, this.littleEndian);
    this.offset += 8;
    return val;
  }

  private readCoord(): number[] {
    return [this.readFloat64(), this.readFloat64()];
  }

  private readCoordArray(count: number): number[][] {
    const coords: number[][] = [];
    for (let i = 0; i < count; i++) coords.push(this.readCoord());
    return coords;
  }

  private readLineString(): number[][] {
    const numPoints = this.readUint32();
    return this.readCoordArray(numPoints);
  }

  private readPolygon(): number[][][] {
    const numRings = this.readUint32();
    const rings: number[][][] = [];
    for (let i = 0; i < numRings; i++) {
      rings.push(this.readLineString());
    }
    return rings;
  }

  readGeometry(): GeoJSONGeometry {
    this.littleEndian = this.readByte() === 1;
    let geomType = this.readUint32();

    // Handle EWKB (geometry type with SRID flag)
    const hasSRID = (geomType & 0x20000000) !== 0;
    geomType = geomType & 0xff;
    if (hasSRID) this.readUint32(); // skip SRID

    switch (geomType) {
      case WKB_POINT:
        return { type: "Point", coordinates: this.readCoord() };

      case WKB_LINESTRING:
        return { type: "LineString", coordinates: this.readLineString() };

      case WKB_POLYGON:
        return { type: "Polygon", coordinates: this.readPolygon() };

      case WKB_MULTIPOINT: {
        const n = this.readUint32();
        const coords: number[][] = [];
        for (let i = 0; i < n; i++) coords.push(this.readGeometry().coordinates as number[]);
        return { type: "MultiPoint", coordinates: coords };
      }

      case WKB_MULTILINESTRING: {
        const n = this.readUint32();
        const lines: number[][][] = [];
        for (let i = 0; i < n; i++) lines.push((this.readGeometry() as any).coordinates);
        return { type: "MultiLineString", coordinates: lines };
      }

      case WKB_MULTIPOLYGON: {
        const n = this.readUint32();
        const polys: number[][][][] = [];
        for (let i = 0; i < n; i++) polys.push((this.readGeometry() as any).coordinates);
        return { type: "MultiPolygon", coordinates: polys };
      }

      case WKB_GEOMETRYCOLLECTION: {
        const n = this.readUint32();
        const geoms: GeoJSONGeometry[] = [];
        for (let i = 0; i < n; i++) geoms.push(this.readGeometry());
        return { type: "GeometryCollection", geometries: geoms };
      }

      default:
        throw new Error(`Unsupported WKB geometry type: ${geomType}`);
    }
  }
}

/** Parse WKB binary data to GeoJSON geometry. */
export function wkbToGeoJSON(wkb: Uint8Array): GeoJSONGeometry {
  const reader = new WKBReader(wkb.buffer.slice(wkb.byteOffset, wkb.byteOffset + wkb.byteLength));
  return reader.readGeometry();
}

// ---------------------------------------------------------------------------
// WKT rendering — matches DuckDB spatial's ST_AsText output
// ---------------------------------------------------------------------------

const coordToWKT = (c: number[]): string => c.map((n) => String(n)).join(" ");
const coordsToWKT = (cs: number[][]): string => cs.map(coordToWKT).join(", ");
/** Wrap each ring (or sub-line) in parens: `(0 0, 1 1), (2 2, 3 3)`. */
const ringsToWKT = (rings: number[][][]): string => rings.map((r) => `(${coordsToWKT(r)})`).join(", ");

function geometryToWKT(g: GeoJSONGeometry): string {
  switch (g.type) {
    case "Point":
      // WKB POINT EMPTY encodes as NaN coordinates; DuckDB prints `POINT EMPTY`.
      return g.coordinates.length && !g.coordinates.some((n) => Number.isNaN(n))
        ? `POINT (${coordToWKT(g.coordinates)})`
        : "POINT EMPTY";
    case "LineString":
      return g.coordinates.length ? `LINESTRING (${coordsToWKT(g.coordinates)})` : "LINESTRING EMPTY";
    case "Polygon":
      return g.coordinates.length ? `POLYGON (${ringsToWKT(g.coordinates)})` : "POLYGON EMPTY";
    case "MultiPoint":
      // DuckDB renders MULTIPOINT without per-point parens: `MULTIPOINT (1 2, 3 4)`.
      return g.coordinates.length ? `MULTIPOINT (${coordsToWKT(g.coordinates)})` : "MULTIPOINT EMPTY";
    case "MultiLineString":
      return g.coordinates.length ? `MULTILINESTRING (${ringsToWKT(g.coordinates)})` : "MULTILINESTRING EMPTY";
    case "MultiPolygon":
      return g.coordinates.length
        ? `MULTIPOLYGON (${g.coordinates.map((poly) => `(${ringsToWKT(poly)})`).join(", ")})`
        : "MULTIPOLYGON EMPTY";
    case "GeometryCollection":
      return g.geometries.length
        ? `GEOMETRYCOLLECTION (${g.geometries.map(geometryToWKT).join(", ")})`
        : "GEOMETRYCOLLECTION EMPTY";
  }
}

/** Parse WKB and render as DuckDB-style WKT, e.g. `POINT (-78.4 38.0)`.
 *  Throws (via wkbToGeoJSON) on malformed/unsupported WKB — callers that want
 *  a graceful fallback should catch and render the raw blob instead. */
export function wkbToWKT(wkb: Uint8Array): string {
  return geometryToWKT(wkbToGeoJSON(wkb));
}

// ---------------------------------------------------------------------------
// Winding-order correction for d3-geo / Vega-Lite
// ---------------------------------------------------------------------------

/** Signed area of a ring via the shoelace formula (planar lon/lat).
 *  > 0 ⇒ counter-clockwise, < 0 ⇒ clockwise. */
function ringSignedArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Orient a polygon's rings the way d3-geo wants: exterior CLOCKWISE, holes
 *  COUNTER-clockwise. Reverses only the rings that are wound the wrong way. */
function rewindRings(rings: number[][][]): number[][][] {
  return rings.map((ring, i) => {
    const isClockwise = ringSignedArea(ring) < 0;
    const wantClockwise = i === 0; // first ring = exterior
    return wantClockwise === isClockwise ? ring : [...ring].reverse();
  });
}

/**
 * Rewind a GeoJSON geometry to the ring orientation d3-geo / Vega-Lite require:
 * exterior rings CLOCKWISE, holes COUNTER-clockwise.
 *
 * Geometry from DuckDB / Overture / most WKB sources uses the opposite (or
 * inconsistent) winding. d3-geo projects on a SPHERE and is winding-sensitive:
 * a wrongly-wound polygon is interpreted as "the entire globe EXCEPT this
 * shape", so it floods the whole map (and a layer of them collapses to one
 * color). Idempotent. Non-polygon geometries pass through unchanged.
 */
export function rewindGeometryForD3(geom: any): any {
  if (!geom || typeof geom !== "object") return geom;
  if (geom.type === "Polygon") return { ...geom, coordinates: rewindRings(geom.coordinates) };
  if (geom.type === "MultiPolygon") return { ...geom, coordinates: geom.coordinates.map(rewindRings) };
  if (geom.type === "GeometryCollection") {
    return { ...geom, geometries: (geom.geometries ?? []).map(rewindGeometryForD3) };
  }
  return geom;
}
