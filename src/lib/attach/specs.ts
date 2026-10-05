/**
 * Decoding a catalog's declared attach options (`CatalogInfo.attach_option_specs`)
 * into the plain `OptionSpecInfo` records the shell and the options form use.
 */
import { deserializeAttachOptionSpecs, type AttachOptionSpec } from "vgi/client";
import type { DataType } from "@query-farm/apache-arrow";
import { arrowTypeToDuckDB, arrowTypeToDuckDBCast } from "../arrow-to-duckdb";
import type { OptionSpecInfo } from "./options";

/** Decode the serialized specs. A spec that fails to decode is skipped with a
 *  console warning rather than failing the catalog: the extension still
 *  validates options at ATTACH, so a missing spec only costs the form a row. */
export function decodeOptionSpecs(serialized: readonly Uint8Array[] | undefined): OptionSpecInfo[] {
  if (!serialized?.length) return [];
  let specs: AttachOptionSpec[];
  try {
    specs = deserializeAttachOptionSpecs(serialized);
  } catch (error) {
    console.warn("[attach] could not decode attach option specs:", error);
    return [];
  }
  return specs.map(toOptionSpecInfo);
}

export function toOptionSpecInfo(spec: AttachOptionSpec): OptionSpecInfo {
  const type = spec.type as unknown as DataType;
  return {
    name: spec.name,
    description: spec.description ?? "",
    duckdbType: arrowTypeToDuckDB(type),
    castType: arrowTypeToDuckDBCast(type),
    arrowType: String(type),
    required: Boolean(spec.required),
    secret: Boolean(spec.secret),
    defaultText: spec.secret ? null : defaultText(spec.default),
  };
}

function defaultText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}
