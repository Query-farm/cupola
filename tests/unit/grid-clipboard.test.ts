import { describe, it, expect } from "bun:test";
import { buildGridClipboard, type CellRect } from "../../src/lib/grid-clipboard";
import type { ColumnInfo } from "../../src/lib/service";

const columnNames = ["id", "name", "notes"];

const infoByName = new Map<string, ColumnInfo>([
  ["id", { name: "id", arrowType: "Int64", duckdbType: "BIGINT", nullable: false }],
  ["name", { name: "name", arrowType: "Utf8", duckdbType: "VARCHAR", nullable: true }],
  ["notes", { name: "notes", arrowType: "Utf8", duckdbType: "VARCHAR", nullable: true }],
]);

// No Arrow fields needed for these plain scalar/string values.
const fieldByName = new Map<string, any>();

const rows: Record<string, any>[] = [
  { id: 1, name: "Alice", notes: "first" },
  { id: 2, name: "Bob", notes: null },
  { id: 3, name: "quote\"d", notes: "has\ttab" },
];

function rect(rowMin: number, rowMax: number, colMin: number, colMax: number): CellRect {
  return { rowMin, rowMax, colMin, colMax };
}

describe("buildGridClipboard", () => {
  it("copies a single cell as its raw value with no separators", () => {
    const { text, html } = buildGridClipboard(rows, columnNames, fieldByName, infoByName, rect(0, 0, 1, 1));
    expect(text).toBe("Alice");
    expect(html).toBe("<table><tr><td>Alice</td></tr></table>");
  });

  it("joins a multi-cell rectangle with tabs and newlines", () => {
    const { text } = buildGridClipboard(rows, columnNames, fieldByName, infoByName, rect(0, 1, 0, 1));
    expect(text).toBe("1\tAlice\n2\tBob");
  });

  it("renders NULL/undefined as an empty cell", () => {
    const { text, html } = buildGridClipboard(rows, columnNames, fieldByName, infoByName, rect(1, 1, 2, 2));
    expect(text).toBe("");
    expect(html).toBe("<table><tr><td></td></tr></table>");
  });

  it("quotes TSV values containing a tab or a double quote", () => {
    const { text } = buildGridClipboard(rows, columnNames, fieldByName, infoByName, rect(2, 2, 1, 2));
    // name = quote"d  → "quote""d" ; notes = has<TAB>tab → "has\ttab"
    expect(text).toBe('"quote""d"\t"has\ttab"');
  });

  it("escapes &<> in the HTML table", () => {
    const htmlRows = [{ a: "a & b <c>" }];
    const cols = ["a"];
    const info = new Map<string, ColumnInfo>([
      ["a", { name: "a", arrowType: "Utf8", duckdbType: "VARCHAR", nullable: true }],
    ]);
    const { html } = buildGridClipboard(htmlRows, cols, new Map(), info, rect(0, 0, 0, 0));
    expect(html).toBe("<table><tr><td>a &amp; b &lt;c&gt;</td></tr></table>");
  });

  it("clamps a rectangle that runs past the loaded rows/columns", () => {
    const { text } = buildGridClipboard(rows, columnNames, fieldByName, infoByName, rect(0, 99, 0, 99));
    expect(text.split("\n").length).toBe(3);
    expect(text.split("\n")[0]).toBe("1\tAlice\tfirst");
  });
});
