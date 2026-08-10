/**
 * Locale digit grouping — the `grouping` option on formatCellValue.
 *
 * Grouping is opt-in because formatCellValue also produces CSV/XLSX exports,
 * clipboard payloads and the text the AI agent reads. These tests pin both
 * halves: that the option works, and that the default output is untouched.
 */
import { test, expect } from "bun:test";
import { formatCellValue } from "../../src/lib/format";

/** Minimal Arrow-field stand-in — formatCellValue only reads type + metadata. */
const field = (type: string) => ({ type: { toString: () => type }, metadata: new Map() });
const GROUPED = { grouping: true };

test("groups integers, including negatives", () => {
  expect(formatCellValue(1234567, "n", field("Int64"), undefined, GROUPED)).toBe("1,234,567");
  expect(formatCellValue(-1234567, "n", field("Int64"), undefined, GROUPED)).toBe("-1,234,567");
  expect(formatCellValue(999, "n", field("Int32"), undefined, GROUPED)).toBe("999");
});

test("groups only the integer part of a float", () => {
  expect(formatCellValue(1234.5, "n", field("Float64"), undefined, GROUPED)).toBe("1,234.5");
});

test("preserves the DuckDB .0 suffix on whole doubles", () => {
  expect(formatCellValue(42, "n", field("Float64"), undefined, GROUPED)).toBe("42.0");
  expect(formatCellValue(1234567, "n", field("Float64"), undefined, GROUPED)).toBe("1,234,567.0");
});

test("leaves DuckDB's non-finite sentinels alone", () => {
  expect(formatCellValue(NaN, "n", field("Float64"), undefined, GROUPED)).toBe("nan");
  expect(formatCellValue(Infinity, "n", field("Float64"), undefined, GROUPED)).toBe("inf");
  expect(formatCellValue(-Infinity, "n", field("Float64"), undefined, GROUPED)).toBe("-inf");
});

test("does not mangle BIT, which renders as a digit string", () => {
  // The type gate exists for exactly this: "10101" is numeric-shaped but is a
  // bitstring, and grouping would turn it into "10,101".
  expect(formatCellValue("10101", "b", field("Binary"), "BIT", GROUPED)).toBe("10101");
});

test("leaves non-numeric types alone", () => {
  expect(formatCellValue("abc", "s", field("Utf8"), undefined, GROUPED)).toBe("abc");
});

test("default output is byte-identical without the option", () => {
  // The export / clipboard / AI paths rely on this.
  for (const v of [1234567, -1234567, 1234.5, 42]) {
    const plain = formatCellValue(v, "n", field("Float64"));
    expect(plain).not.toContain(",");
  }
  expect(formatCellValue(1234567, "n", field("Int64"))).toBe("1234567");
});
