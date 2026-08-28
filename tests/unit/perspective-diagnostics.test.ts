import { describe, expect, test } from "bun:test";
import { tableFromArrays, tableFromIPC, tableToIPC } from "@query-farm/apache-arrow";
import { describePerspectiveArrowInput } from "../../src/lib/perspective-diagnostics";

describe("Perspective Arrow diagnostics", () => {
  test("records payload shape and extension schema without row values", () => {
    const table = tableFromArrays({
      account_id: ["private-account-value"],
      amount: [42],
    });
    const accountField = table.schema.fields[0];
    accountField.metadata.set("ARROW:extension:name", "arrow.uuid");
    accountField.metadata.set("ARROW:extension:metadata", JSON.stringify({ type_name: "uuid" }));
    accountField.metadata.set("customer-specific-key", "must-not-be-recorded");

    const bytes = tableToIPC(table, "file");
    const diagnostics = describePerspectiveArrowInput(bytes);

    expect(diagnostics).toMatchObject({
      decoded: true,
      ipcFormat: "file",
      rowCount: 1,
      batchCount: 1,
      batchRowCounts: [1],
      columnCount: 2,
    });
    expect(diagnostics.bufferBytes).toBe(bytes.byteLength);
    expect(diagnostics.fields?.[0]).toMatchObject({
      index: 0,
      name: "account_id",
      nullable: true,
      extensionName: "arrow.uuid",
      extensionMetadata: JSON.stringify({ type_name: "uuid" }),
      metadataKeys: [
        "ARROW:extension:metadata",
        "ARROW:extension:name",
        "customer-specific-key",
      ],
    });

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("private-account-value");
    expect(serialized).not.toContain("must-not-be-recorded");
  });

  test("a pre-parsed table (loadPerspective's shared-parse path) produces identical diagnostics", () => {
    const table = tableFromArrays({ n: [1, 2, 3] });
    const bytes = tableToIPC(table, "file");

    const fromBuffer = describePerspectiveArrowInput(bytes);
    const fromPreParsed = describePerspectiveArrowInput(bytes, tableFromIPC(bytes));

    expect(fromPreParsed).toEqual(fromBuffer);
  });

  test("still describes malformed IPC without throwing", () => {
    const diagnostics = describePerspectiveArrowInput(new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]));

    expect(diagnostics).toMatchObject({
      bufferBytes: 6,
      ipcFormat: "file",
      decoded: false,
    });
    expect(diagnostics.decodeError).toBeTruthy();
  });
});
