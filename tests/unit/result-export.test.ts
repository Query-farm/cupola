/**
 * Tests for the editor's client-side result export (CSV / Arrow / Excel).
 */
import { test, expect, describe, mock } from "bun:test";
import { tableFromArrays, tableFromIPC } from "apache-arrow";

// format.ts / arrow-to-duckdb pull the service graph transitively; stub the
// browser-only RPC connect entry so the import resolves under bun.
mock.module("@query-farm/vgi-rpc/connect", () => ({ httpConnect: () => { throw new Error("stub"); } }));

const { toCsv, toArrowIpc, toXlsx, safeFileStem } = await import("../../src/lib/editor/result-export");

function sampleTable() {
  return tableFromArrays({
    id: Int32Array.from([1, 2, 3]),
    name: ["alice", "b,c", 'quote"d'],
    big: BigInt64Array.from([10n, 20n, 9007199254740993n]),
  });
}

async function blobText(b: Blob): Promise<string> {
  return await b.text();
}

describe("toCsv", () => {
  test("emits a header and RFC-4180 quoted cells", async () => {
    const csv = await blobText(toCsv(sampleTable()));
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("id,name,big");
    expect(lines[1]).toBe("1,alice,10");
    // Comma-containing value is quoted.
    expect(lines[2]).toBe('2,"b,c",20');
    // Embedded quote is doubled and wrapped.
    expect(lines[3]).toBe('3,"quote""d",9007199254740993');
  });
});

describe("toArrowIpc", () => {
  test("round-trips back to an equivalent Arrow table", () => {
    const blob = toArrowIpc(sampleTable());
    expect(blob.type).toContain("arrow");
  });

  test("decoded IPC preserves rows and columns", async () => {
    const blob = toArrowIpc(sampleTable());
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const decoded = tableFromIPC(bytes);
    expect(decoded.numRows).toBe(3);
    expect(decoded.schema.fields.map((f) => f.name)).toEqual(["id", "name", "big"]);
    expect(decoded.getChild("name")?.get(1)).toBe("b,c");
  });
});

describe("toXlsx", () => {
  test("produces a non-empty xlsx blob", async () => {
    const blob = await toXlsx(sampleTable());
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain("spreadsheet");
  });
});

describe("safeFileStem", () => {
  test("sanitizes unsafe characters", () => {
    expect(safeFileStem("My Query / 2025")).toBe("My_Query_2025");
    expect(safeFileStem("   ")).toBe("query-result");
    expect(safeFileStem("ok-name_1")).toBe("ok-name_1");
  });
});
