/**
 * Privacy-conscious diagnostics for Arrow IPC handed to Perspective.
 *
 * We intentionally record the schema and shape, but never inspect or serialize
 * row values. SQL is supplied separately by the caller when it is available.
 */
import { tableFromIPC, type Field } from "@query-farm/apache-arrow";

export interface PerspectiveArrowFieldDiagnostics {
  index: number;
  name: string;
  type: string;
  typeId: number;
  nullable: boolean;
  extensionName?: string;
  extensionMetadata?: string;
  metadataKeys?: string[];
  children?: PerspectiveArrowFieldDiagnostics[];
}

export interface PerspectiveArrowDiagnostics {
  bufferBytes: number;
  ipcFormat: "file" | "stream-or-unknown";
  decoded: boolean;
  rowCount?: number;
  batchCount?: number;
  batchRowCounts?: number[];
  columnCount?: number;
  fields?: PerspectiveArrowFieldDiagnostics[];
  decodeError?: string;
}

function describeField(field: Field, index: number): PerspectiveArrowFieldDiagnostics {
  const metadataKeys = [...field.metadata.keys()].sort();
  const children: Field[] = field.type.children ?? [];
  const diagnostics: PerspectiveArrowFieldDiagnostics = {
    index,
    name: field.name,
    type: field.type.toString(),
    typeId: Number(field.typeId),
    nullable: field.nullable,
  };

  const extensionName = field.metadata.get("ARROW:extension:name");
  const extensionMetadata = field.metadata.get("ARROW:extension:metadata");
  if (extensionName !== undefined) diagnostics.extensionName = extensionName;
  if (extensionMetadata !== undefined) diagnostics.extensionMetadata = extensionMetadata;
  if (metadataKeys.length > 0) diagnostics.metadataKeys = metadataKeys;
  if (children.length > 0) {
    diagnostics.children = children.map((child, childIndex) => describeField(child, childIndex));
  }

  return diagnostics;
}

/** Describe enough of an Arrow payload to reproduce type-loader failures.
 * Never includes cell values. Malformed IPC still produces buffer-level
 * diagnostics plus the Arrow decoder error. */
export function describePerspectiveArrowInput(
  buffer: ArrayBuffer | Uint8Array,
): PerspectiveArrowDiagnostics {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const isFile = bytes.byteLength >= 6
    && bytes[0] === 0x41 && bytes[1] === 0x52 && bytes[2] === 0x52
    && bytes[3] === 0x4f && bytes[4] === 0x57 && bytes[5] === 0x31;
  const diagnostics: PerspectiveArrowDiagnostics = {
    bufferBytes: bytes.byteLength,
    ipcFormat: isFile ? "file" : "stream-or-unknown",
    decoded: false,
  };

  try {
    const table = tableFromIPC(bytes);
    diagnostics.decoded = true;
    diagnostics.rowCount = table.numRows;
    diagnostics.batchCount = table.batches.length;
    diagnostics.batchRowCounts = table.batches.map((batch) => batch.numRows);
    diagnostics.columnCount = table.numCols;
    diagnostics.fields = table.schema.fields.map((field, index) => describeField(field, index));
  } catch (error) {
    diagnostics.decodeError = error instanceof Error ? error.message : String(error);
  }

  return diagnostics;
}
