/**
 * Convert Apache Arrow type strings and field metadata to DuckDB display types.
 *
 * DuckDB serializes its types to Arrow IPC. This module reverses the mapping
 * so the UI can display familiar DuckDB type names (VARCHAR, INTEGER, etc.)
 * instead of raw Arrow types (Utf8, Int32, etc.).
 *
 * Also checks ARROW:extension:name metadata for extension types like geoarrow.wkb.
 */

import type { Field, DataType } from "@query-farm/apache-arrow";

/** Convert an Arrow Field to a DuckDB type display string. */
export function arrowFieldToDuckDB(field: Field): string {
  // Check extension metadata first (e.g., geoarrow.wkb → GEOMETRY)
  const extName = field.metadata?.get("ARROW:extension:name");
  if (extName) {
    const mapped = extensionTypeMap[extName];
    if (mapped) return mapped;
  }
  return arrowTypeToDuckDB(field.type);
}

/** Convert an Arrow DataType to a DuckDB type display string. */
export function arrowTypeToDuckDB(type: DataType): string {
  const str = type.toString();
  return mapTypeString(str);
}

/** Map an Arrow type string to DuckDB. Handles nested types recursively. */
function mapTypeString(s: string): string {
  // Exact matches first
  const exact = simpleTypeMap[s];
  if (exact) return exact;

  // Parameterized types
  if (s.startsWith("Decimal128(")) {
    return s.replace("Decimal128", "DECIMAL");
  }
  if (s.startsWith("Decimal256(")) {
    return s.replace("Decimal256", "DECIMAL");
  }
  if (s.startsWith("FixedSizeBinary(")) {
    const size = s.match(/\d+/)?.[0] ?? "";
    return `BLOB[${size}]`;
  }
  if (s.startsWith("Timestamp<")) {
    const tz = s.includes(",");
    if (s.includes("SECOND")) return tz ? "TIMESTAMPTZ" : "TIMESTAMP_S";
    if (s.includes("MILLISECOND")) return tz ? "TIMESTAMPTZ" : "TIMESTAMP_MS";
    if (s.includes("NANOSECOND")) return tz ? "TIMESTAMPTZ" : "TIMESTAMP_NS";
    return tz ? "TIMESTAMPTZ" : "TIMESTAMP";
  }
  if (s.startsWith("Duration<")) {
    return "INTERVAL";
  }
  if (s.startsWith("Time32<")) return "TIME";
  if (s.startsWith("Time64<")) return "TIME";
  if (s.startsWith("Date32<")) return "DATE";
  if (s.startsWith("Date64<")) return "DATE";

  // List types: List<Field> or LargeList<Field>
  const listMatch = s.match(/^(?:Large)?List<(.+)>$/);
  if (listMatch) {
    // Inner is "fieldname: type" — extract the type part
    const inner = listMatch[1];
    const colonIdx = inner.indexOf(": ");
    const innerType = colonIdx >= 0 ? inner.slice(colonIdx + 2) : inner;
    return `${mapTypeString(innerType)}[]`;
  }

  // Map types
  const mapMatch = s.match(/^Map<(.+)>$/);
  if (mapMatch) {
    return `MAP(${mapMatch[1]})`;
  }

  // Struct types
  if (s.startsWith("Struct<")) {
    return s.replace("Struct", "STRUCT");
  }

  // Union types
  if (s.startsWith("DenseUnion<") || s.startsWith("SparseUnion<")) {
    return "UNION";
  }

  // Fall through — return as-is (already readable enough)
  return s;
}

/** Simple 1:1 Arrow type name → DuckDB type name. */
const simpleTypeMap: Record<string, string> = {
  // Strings
  "Utf8": "VARCHAR",
  "LargeUtf8": "VARCHAR",
  "utf8": "VARCHAR",
  "string": "VARCHAR",

  // Integers
  "Int8": "TINYINT",
  "Int16": "SMALLINT",
  "Int32": "INTEGER",
  "Int64": "BIGINT",
  "Uint8": "UTINYINT",
  "Uint16": "USMALLINT",
  "Uint32": "UINTEGER",
  "Uint64": "UBIGINT",
  "int8": "TINYINT",
  "int16": "SMALLINT",
  "int32": "INTEGER",
  "int64": "BIGINT",

  // Floats
  "Float16": "FLOAT",
  "Float32": "FLOAT",
  "Float64": "DOUBLE",
  "float16": "FLOAT",
  "float32": "FLOAT",
  "float64": "DOUBLE",

  // Boolean
  "Bool": "BOOLEAN",
  "bool": "BOOLEAN",

  // Binary
  "Binary": "BLOB",
  "LargeBinary": "BLOB",
  "binary": "BLOB",

  // Date/Time (without angle brackets — some Arrow impls use these)
  "Date32": "DATE",
  "Date64": "DATE",
  "date32": "DATE",
  "date64": "DATE",

  // Null
  "Null": "NULL",
};

/** Arrow extension type name → DuckDB type name. */
const extensionTypeMap: Record<string, string> = {
  "geoarrow.wkb": "GEOMETRY",
  "geoarrow.point": "GEOMETRY",
  "geoarrow.linestring": "GEOMETRY",
  "geoarrow.polygon": "GEOMETRY",
  "geoarrow.multipoint": "GEOMETRY",
  "geoarrow.multilinestring": "GEOMETRY",
  "geoarrow.multipolygon": "GEOMETRY",
  "arrow.uuid": "UUID",
  "arrow.json": "JSON",
};
