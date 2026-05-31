/**
 * Query-result serialization for the AI agent.
 *
 * Converts an Arrow result table into the JSON the model sees, and caches results so the
 * agent can page through them via `read_query_results`.
 *
 * Critically, this uses the SAME extraction + formatter as the shell/grid display path
 * (`safeGetArrowValue` + `formatCellValue` from `./format`), so the AI never sees a value that
 * differs from what the user sees. A previous hand-rolled formatter drifted from the display
 * path and fed the model wrong values (HUGEINT double-escaped as `"\"\\\"6\\\"\""`, TIME/INTERVAL
 * garbage, lossy timestamps). Keeping one pipeline — and unit-testing it here — is the fix for
 * that whole class of bugs.
 *
 * This module deliberately depends only on the pure `./format` helpers (no VGI/service imports)
 * so it can be unit-tested in isolation.
 */

import { formatCellValue, safeGetArrowValue } from "./format";

// ---------------------------------------------------------------------------
// Result cache — bounded to last 3 query results
// ---------------------------------------------------------------------------

interface CachedResult {
  columns: string[];
  types: string[];
  rows: Record<string, any>[];
  rowCount: number;
}

const resultCache = new Map<string, CachedResult>();
let resultCounter = 0;

function cacheResult(result: CachedResult): string {
  const id = `result_${++resultCounter}`;
  resultCache.set(id, result);
  // Evict oldest if more than 3
  if (resultCache.size > 3) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Cell formatting
// ---------------------------------------------------------------------------

/** Max length of a single cell string in the AI's JSON view — caps blobs/long text so a
 *  wide row can't blow the model's context window. */
const AI_CELL_MAX_LEN = 200;

/**
 * Format one cell for the AI's JSON view.
 *
 * AI-specific tweaks vs. display: NULL stays `null` (not ""), binary blobs collapse to
 * "[binary]" instead of a long hex string, and long strings are capped.
 */
export function formatCellForAI(column: any, row: number, field: any): any {
  const raw = safeGetArrowValue(column, row, field);
  if (raw === null || raw === undefined) return null;
  // Genuine BLOBs arrive as bare bytes. Extension types (hugeint/uhugeint/uuid/time_tz) are
  // already converted to tagged objects by safeGetArrowValue, and Decimal128/HUGEINT arrives as
  // a Uint32Array subclass — none of those are `instanceof Uint8Array`, so only real binary hits
  // this branch.
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) return "[binary]";
  const s = formatCellValue(raw, field?.name, field);
  return s.length > AI_CELL_MAX_LEN ? s.slice(0, AI_CELL_MAX_LEN - 1) + "…" : s;
}

/**
 * Cap a single already-decoded JS value (from `readRows`/`tableToRows`) for
 * inclusion in an AI tool_result.
 *
 * The render_chart sample path doesn't go through the Arrow-column formatter
 * above — it samples plain JS rows. Without capping, a GEOMETRY column (WKB
 * BLOB → Uint8Array) serializes under JSON.stringify as a per-byte object
 * (`{"0":12,"1":34,…}`), so a few large geometries balloon to hundreds of KB
 * and blow the model's input limit. This mirrors formatCellForAI's intent:
 * binary collapses to a short tag, long strings truncate, structs recurse.
 */
export function capValueForAI(v: any): any {
  if (v === null || v === undefined) return v;
  // Same blob check as formatCellForAI — genuine binary only. Decimal128/
  // HUGEINT arrive as Uint32Array subclasses and must NOT be collapsed.
  if (v instanceof Uint8Array) return `[binary ${v.byteLength} bytes]`;
  if (v instanceof ArrayBuffer) return `[binary ${v.byteLength} bytes]`;
  if (typeof v === "string") return v.length > AI_CELL_MAX_LEN ? v.slice(0, AI_CELL_MAX_LEN - 1) + "…" : v;
  if (Array.isArray(v)) return v.map(capValueForAI);
  if (typeof v === "object" && v.constructor === Object) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = capValueForAI(val);
    return out;
  }
  return v;
}

/** Build a context-safe sample of plain-JS rows (from readRows) for an AI
 *  tool_result — slices to `maxRows` and caps every cell via capValueForAI. */
export function sampleRowsForAI(rows: Record<string, any>[], maxRows = 3): Record<string, any>[] {
  return rows.slice(0, maxRows).map((row) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) out[k] = capValueForAI(v);
    return out;
  });
}

export function formatArrowTableAsJson(
  table: any,
  maxRows = 20
): { json: string; resultId: string } {
  const fields = table.schema.fields;
  const columns = fields.map((f: any) => f.name);
  const types = fields.map((f: any) => f.type?.toString() || "unknown");
  const cols = fields.map((_: any, c: number) => table.getChildAt(c));
  const numRows = table.numRows;
  const limit = Math.min(maxRows, numRows);

  // Build up to CACHE_LIMIT rows once; the response shows the first `limit` of them.
  const CACHE_LIMIT = 10_000;
  const rowsToCache = Math.min(numRows, CACHE_LIMIT);
  const allRows: Record<string, any>[] = [];
  for (let r = 0; r < rowsToCache; r++) {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      row[columns[c]] = formatCellForAI(cols[c], r, fields[c]);
    }
    allRows.push(row);
  }
  const rows = allRows.slice(0, limit);
  const resultId = cacheResult({ columns, types, rows: allRows, rowCount: numRows });

  const result = {
    columns,
    types,
    rows,
    row_count: numRows,
    showing: limit,
    result_id: resultId,
  };

  return { json: JSON.stringify(result), resultId };
}

export function executeReadQueryResults(resultId: string, offset = 0, limit = 20): string {
  const cached = resultCache.get(resultId);
  if (!cached) return JSON.stringify({ error: `Result '${resultId}' not found or expired` });

  const clampedLimit = Math.min(limit, 100);
  const slice = cached.rows.slice(offset, offset + clampedLimit);
  return JSON.stringify({
    columns: cached.columns,
    types: cached.types,
    rows: slice,
    offset,
    showing: slice.length,
    row_count: cached.rowCount,
    result_id: resultId,
  });
}

// ---------------------------------------------------------------------------
// Context pruning — keep chart images from bloating the conversation
// ---------------------------------------------------------------------------

/** Structural view of an agent message — matches MessageParam/ToolResultBlock/
 *  ToolResultContent in ./ai-agent without importing that module's
 *  browser-only service graph (so this file stays unit-testable in isolation). */
interface PrunableMessage {
  content: unknown;
}

/**
 * Drop chart images (render_chart tool_results) from every message except the
 * last one. An image is only sent back so the model can SEE the chart it just
 * drew and revise it — that evaluation happens in the single request right
 * after the render, which is always the final message. Once anything follows
 * it (the model's revision, or a new user turn) the PNG has served its purpose
 * and is pure bloat: each costs ~1.5k input tokens and is re-sent on every
 * later request, which is what pushes a chart-heavy conversation past the
 * model's input limit.
 *
 * Mutates `messages` in place. runAgentTurn passes the caller's own array
 * (e.g. AskAIChat's persistent agentMessages ref), so images are shed from
 * stored history too and don't re-accumulate across turns. The tool_result's
 * text part is preserved so the model still knows the chart rendered
 * (row count, columns, warnings).
 */
export function pruneCarriedToolImages(messages: PrunableMessage[]): void {
  const PLACEHOLDER = "[chart image removed from history to save context]";
  for (let i = 0; i < messages.length - 1; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      if (!block.content.some((p: any) => p?.type === "image")) continue;
      const text = block.content
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text)
        .join(" ");
      block.content = text ? `${text}\n${PLACEHOLDER}` : PLACEHOLDER;
    }
  }
}
