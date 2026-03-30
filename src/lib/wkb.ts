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
