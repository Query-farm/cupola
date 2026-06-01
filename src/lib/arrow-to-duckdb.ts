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
  //
  // apache-arrow's Decimal.toString() emits `Decimal[<precision>e<±scale>]`
  // (e.g. DECIMAL(18,4) → "Decimal[18e+4]", scale 0 → "Decimal[18e0]",
  // negative scale → "Decimal[18e-2]"). It does NOT use the `Decimal128(p, s)`
  // form, so match the bracket form first. bitWidth (128 vs 256) isn't encoded
  // in the string, but DuckDB renders both as DECIMAL(p, s) anyway.
  const decimalMatch = s.match(/^Decimal\[(\d+)e([+-]?\d+)\]$/);
  if (decimalMatch) {
    return `DECIMAL(${decimalMatch[1]},${parseInt(decimalMatch[2], 10)})`;
  }
  // Fallbacks for Arrow impls that use the function-call form.
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

  // Dictionary types: Dictionary<IndexType, ValueType>
  // DuckDB uses dictionary encoding for ENUM and low-cardinality columns.
  // The DuckDB type is determined by the value type (e.g., Dictionary<Int16, Utf8> → VARCHAR).
  const dictMatch = s.match(/^Dictionary<[^,]+,\s*(.+)>$/);
  if (dictMatch) {
    return mapTypeString(dictMatch[1]);
  }

  // List types: List<Field> or LargeList<Field>
  const listMatch = s.match(/^(?:Large)?List<(.+)>$/);
  if (listMatch) {
    // Inner is "fieldname: type" — extract the type part
    const inner = listMatch[1];
    const colonIdx = inner.indexOf(": ");
    const innerType = colonIdx >= 0 ? inner.slice(colonIdx + 2) : inner;
    return `${mapTypeString(innerType)}[]`;
  }

  // Map types: Map<{key: K, value: V}> or Map<entries: Struct<{key: K, value: V}>>.
  // Recurse into key/value so nested types are converted too → MAP(K, V).
  const mapMatch = s.match(/^Map<(.+)>$/);
  if (mapMatch) {
    let kv = parseStructBody(mapMatch[1]);
    // Unwrap a single `entries: Struct<{...}>` wrapper if present.
    if (kv && kv.length === 1 && kv[0].type.startsWith("Struct<")) {
      kv = parseStructBody(kv[0].type.slice("Struct<".length, -1));
    }
    if (kv) {
      const key = kv.find((f) => f.name === "key");
      const value = kv.find((f) => f.name === "value");
      if (key && value) {
        return `MAP(${mapTypeString(key.type)}, ${mapTypeString(value.type)})`;
      }
    }
    return `MAP(${mapMatch[1]})`;
  }

  // Struct types: Struct<{ name: type, ... }> — recurse into each field's type.
  if (s.startsWith("Struct<")) {
    const fields = parseStructBody(s.slice("Struct<".length, -1));
    if (fields) {
      const inner = fields
        .map((f) => `${f.name}: ${mapTypeString(f.type)}`)
        .join(", ");
      return `STRUCT<{${inner}}>`;
    }
    return s.replace("Struct", "STRUCT");
  }

  // Union types
  if (s.startsWith("DenseUnion<") || s.startsWith("SparseUnion<")) {
    return "UNION";
  }

  // Fall through — return as-is (already readable enough)
  return s;
}

/**
 * Parse a struct/map body of the form `{ name: type, name: type, ... }`
 * (surrounding braces optional) into its top-level fields. Returns null if
 * the body has no usable `name: type` fields.
 */
function parseStructBody(raw: string): Array<{ name: string; type: string }> | null {
  let body = raw.trim();
  if (body.startsWith("{") && body.endsWith("}")) {
    body = body.slice(1, -1);
  }
  const parts = splitTopLevel(body);
  const fields: Array<{ name: string; type: string }> = [];
  for (const part of parts) {
    const idx = topLevelColon(part);
    if (idx < 0) return null;
    fields.push({
      name: part.slice(0, idx).trim(),
      type: part.slice(idx + 1).trim(),
    });
  }
  return fields.length > 0 ? fields : null;
}

/** Split a string on commas that are not nested inside <>, (), {} or [] brackets. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Index of the first `:` that is not nested inside any bracket pair, or -1. */
function topLevelColon(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

/**
 * Short label for compact display (e.g. the sidebar): collapses a STRUCT to
 * its keyword, preserving a trailing `[]` for a list-of-struct. Other types
 * pass through unchanged.
 */
export function shortTypeName(typeStr: string): string {
  if (typeStr.startsWith("STRUCT")) {
    return typeStr.endsWith("[]") ? "STRUCT[]" : "STRUCT";
  }
  return typeStr;
}

/**
 * Pretty-print a (possibly nested) type string with newlines and indentation
 * so deeply-nested STRUCTs are human-readable. Walks the string tracking the
 * bracket stack: struct `{}` bodies get one field per line; commas inside other
 * brackets (e.g. MAP(K, V), DECIMAL(p, s)) stay inline. Non-struct types come
 * back essentially unchanged.
 */
export function formatTypeMultiline(typeStr: string): string {
  let out = "";
  const stack: string[] = [];
  const pad = () => "  ".repeat(stack.length);
  for (let i = 0; i < typeStr.length; i++) {
    const ch = typeStr[i];
    if (ch === "{") {
      stack.push(ch);
      out += "{\n" + pad();
    } else if (ch === "}") {
      stack.pop();
      out += "\n" + pad() + "}";
    } else if (ch === "<" || ch === "(" || ch === "[") {
      stack.push(ch);
      out += ch;
    } else if (ch === ">" || ch === ")" || ch === "]") {
      stack.pop();
      out += ch;
    } else if (ch === "," && stack[stack.length - 1] === "{") {
      out += ",\n" + pad();
      if (typeStr[i + 1] === " ") i++; // swallow the following space
    } else {
      out += ch;
    }
  }
  return out;
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
