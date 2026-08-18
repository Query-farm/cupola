import { wkbToGeoJSON } from "@/lib/wkb";
import type { ReportMapBlock } from "./types";

export interface ReportMapFeature {
  type: "Feature";
  geometry: Record<string, any>;
  properties: Record<string, any>;
}

export interface ReportMapFeatureResult {
  features: ReportMapFeature[];
  skipped: number;
}

const GEOJSON_TYPES = new Set([
  "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection",
]);

function asGeometry(value: unknown): Record<string, any> | null {
  if (value instanceof Uint8Array) {
    try { return wkbToGeoJSON(value); } catch { return null; }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, any>;
    if (typeof candidate.type === "string" && GEOJSON_TYPES.has(candidate.type)) return candidate;
  }
  return null;
}

/** Convert query rows into safe GeoJSON features for the report map. */
export function buildReportMapFeatures(rows: Record<string, any>[], block: ReportMapBlock): ReportMapFeatureResult {
  const features: ReportMapFeature[] = [];
  let skipped = 0;

  for (const row of rows) {
    let geometry: Record<string, any> | null = null;
    if (block.geometryColumn) geometry = asGeometry(row[block.geometryColumn]);
    else if (block.latitudeColumn && block.longitudeColumn) {
      const rawLatitude = row[block.latitudeColumn];
      const rawLongitude = row[block.longitudeColumn];
      const latitude = rawLatitude === null || rawLatitude === undefined || rawLatitude === "" ? Number.NaN : Number(rawLatitude);
      const longitude = rawLongitude === null || rawLongitude === undefined || rawLongitude === "" ? Number.NaN : Number(rawLongitude);
      if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
        geometry = { type: "Point", coordinates: [longitude, latitude] };
      }
    }

    if (!geometry) { skipped++; continue; }
    features.push({ type: "Feature", geometry, properties: { ...row } });
  }

  return { features, skipped };
}

export const DEFAULT_REPORT_MAP_PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777",
];

export function reportMapColorMap(rows: Record<string, any>[], block: ReportMapBlock): Map<string, string> {
  const colors = block.palette?.length ? block.palette : DEFAULT_REPORT_MAP_PALETTE;
  const values = block.colorColumn
    ? [...new Set(rows.map((row) => row[block.colorColumn!]).filter((value) => value !== null && value !== undefined).map(String))]
    : [];
  return new Map(values.map((value, index) => [value, colors[index % colors.length]]));
}
