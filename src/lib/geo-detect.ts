/**
 * Detect whether a set of columns contains spatial data suitable for map visualization.
 * Checks for GEOMETRY columns and lat/lon column name pairs.
 */

import { classifyColumnType } from "./column-profiler";
import type { ColumnInfo } from "./service";

/** Word-boundary regex for latitude column names. */
const LAT_PATTERN = /(?:^|[_\-. ])(?:lat|latitude)(?:$|[_\-. ])/i;

/** Word-boundary regex for longitude column names. */
const LON_PATTERN = /(?:^|[_\-. ])(?:lon|lng|longitude)(?:$|[_\-. ])/i;

/** Returns true if any column has duckdbType "GEOMETRY". */
export function hasGeometryColumn(columns: ColumnInfo[]): boolean {
  return columns.some((c) => c.duckdbType === "GEOMETRY");
}

/** Returns true if there are two different numeric columns matching lat and lon name patterns. */
export function hasLatLonColumns(columns: ColumnInfo[]): boolean {
  let hasLat = false;
  let hasLon = false;
  for (const col of columns) {
    if (classifyColumnType(col.duckdbType) !== "numeric") continue;
    if (LAT_PATTERN.test(col.name)) hasLat = true;
    else if (LON_PATTERN.test(col.name)) hasLon = true;
    if (hasLat && hasLon) return true;
  }
  return false;
}

/** Returns true if the columns indicate the data can be shown on a map. */
export function isMapCapable(columns: ColumnInfo[]): boolean {
  return hasGeometryColumn(columns) || hasLatLonColumns(columns);
}
