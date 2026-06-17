/**
 * Tests for treeIdToShellText — decoding sidebar tree ids into insert text.
 */
import { test, expect, describe, mock } from "bun:test";

// tree.ts transitively pulls service.ts → the browser RPC connect entry.
mock.module("@query-farm/vgi-rpc/connect", () => ({ httpConnect: () => { throw new Error("stub"); } }));

const { treeIdToShellText } = await import("../../src/lib/tree");

describe("treeIdToShellText", () => {
  test("table id → dotted name", () => {
    expect(treeIdToShellText("cat::schema::t:parcels")).toBe("cat.schema.parcels");
  });
  test("view id → dotted name", () => {
    expect(treeIdToShellText("cat::schema::v:summary")).toBe("cat.schema.summary");
  });
  test("column id → bare column name", () => {
    expect(treeIdToShellText("cat::schema::c:parcels/owner")).toBe("owner");
  });
  test("function id → bare name", () => {
    expect(treeIdToShellText("cat::schema::f:st_area")).toBe("st_area");
  });
  test("schema / catalog ids → null", () => {
    expect(treeIdToShellText("cat::schema")).toBeNull();
    expect(treeIdToShellText("cat")).toBeNull();
  });
});
