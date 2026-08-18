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
import type { Field, Table, Vector } from "@query-farm/apache-arrow";

export type AiRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Result cache — one instance per conversation
// ---------------------------------------------------------------------------

interface CachedResult {
  columns: string[];
  types: string[];
  rows: AiRow[];
  rowCount: number;
}

/** Default entries retained per conversation. Each holds up to CACHE_LIMIT
 *  (10k) formatted rows, so this is a memory bound as much as a usefulness
 *  one — the agent normally pages through the most recent result or two. */
const DEFAULT_MAX_ENTRIES = 5;

/**
 * Backing store for the `read_query_results` tool: run_sql stashes the full
 * (up to 10k) row set here and hands the model a `result_id` it can page
 * through without re-running the query.
 *
 * **One instance per conversation.** This used to be a module-level Map with a
 * 3-entry LRU and a module-level counter, shared by all three AI surfaces
 * (AskAIChat, EditorAiPanel, the terminal's `.ai` mode). Because they ran
 * against one cache, a query on any surface could evict a `result_id` another
 * surface had just handed its model — the agent would then ask to page through
 * a result that no longer existed and get `Result 'result_N' not found or
 * expired` for a query it had only just run. Per-conversation instances remove
 * the interference and make the lifetime obvious: the cache dies with the
 * conversation instead of living for the page's whole session.
 */
export class QueryResultCache {
  private readonly entries = new Map<string, CachedResult>();
  private counter = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  /** Store a result set and return the id the model uses to page through it. */
  store(result: CachedResult): string {
    const id = `result_${++this.counter}`;
    this.entries.set(id, result);
    // Map preserves insertion order, so the first key is the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return id;
  }

  get(id: string): CachedResult | undefined {
    return this.entries.get(id);
  }

  /** Drop everything — e.g. when the user starts a new conversation. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
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
 * AI-specific tweaks vs. display: NULL stays `null` (not ""), non-geometry binary blobs
 * collapse to "[binary]" instead of a long hex string, and long strings are capped.
 *
 * GEOMETRY columns are an exception to the binary collapse: they arrive as WKB tagged with a
 * `geoarrow.*` extension name, and `formatCellValue` already renders them as DuckDB-style WKT
 * (e.g. `POINT (-78.4 38.0)`). Letting that through — then capping — gives the model a truncated
 * but meaningful geometry (type + coordinates) instead of an opaque `[binary]`, matching what the
 * user sees in the shell/grid. Only genuine non-geo blobs collapse.
 */
export function formatCellForAI(column: Vector | null, row: number, field: Field): string | null {
  const raw = safeGetArrowValue(column, row, field);
  if (raw === null || raw === undefined) return null;
  // Genuine BLOBs arrive as bare bytes. Extension types (hugeint/uhugeint/uuid/time_tz) are
  // already converted to tagged objects by safeGetArrowValue, and Decimal128/HUGEINT arrives as
  // a Uint32Array subclass — none of those are `instanceof Uint8Array`, so only real binary hits
  // this branch.
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    // Geometry (geoarrow.* WKB) → let formatCellValue render WKT below; everything else is an
    // opaque blob the model can't use, so collapse it to a short tag.
    const extName = field?.metadata?.get?.("ARROW:extension:name");
    if (!(extName && extName.startsWith("geoarrow."))) return "[binary]";
  }
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
export function capValueForAI(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  // Same blob check as formatCellForAI — genuine binary only. Decimal128/
  // HUGEINT arrive as Uint32Array subclasses and must NOT be collapsed.
  if (v instanceof Uint8Array) return `[binary ${v.byteLength} bytes]`;
  if (v instanceof ArrayBuffer) return `[binary ${v.byteLength} bytes]`;
  if (typeof v === "string") return v.length > AI_CELL_MAX_LEN ? v.slice(0, AI_CELL_MAX_LEN - 1) + "…" : v;
  if (Array.isArray(v)) return v.map(capValueForAI);
  if (typeof v === "object" && v.constructor === Object) {
    const out: AiRow = {};
    for (const [k, val] of Object.entries(v)) out[k] = capValueForAI(val);
    return out;
  }
  return v;
}

/** Build a context-safe sample of plain-JS rows (from readRows) for an AI
 *  tool_result — slices to `maxRows` and caps every cell via capValueForAI. */
export function sampleRowsForAI(rows: AiRow[], maxRows = 3): AiRow[] {
  return rows.slice(0, maxRows).map((row) => {
    const out: AiRow = {};
    for (const [k, v] of Object.entries(row)) out[k] = capValueForAI(v);
    return out;
  });
}

export function formatArrowTableAsJson(
  table: Table,
  cache: QueryResultCache,
  maxRows = 20
): { json: string; resultId: string } {
  const fields = table.schema.fields;
  const columns = fields.map((field) => field.name);
  const types = fields.map((field) => field.type?.toString() || "unknown");
  const cols = fields.map((_, index) => table.getChildAt(index));
  const numRows = table.numRows;
  const limit = Math.min(maxRows, numRows);

  // Build up to CACHE_LIMIT rows once; the response shows the first `limit` of them.
  const CACHE_LIMIT = 10_000;
  const rowsToCache = Math.min(numRows, CACHE_LIMIT);
  const allRows: AiRow[] = [];
  for (let r = 0; r < rowsToCache; r++) {
    const row: AiRow = {};
    for (let c = 0; c < fields.length; c++) {
      row[columns[c]] = formatCellForAI(cols[c], r, fields[c]);
    }
    allRows.push(row);
  }
  const rows = allRows.slice(0, limit);
  const resultId = cache.store({ columns, types, rows: allRows, rowCount: numRows });

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

export function executeReadQueryResults(
  cache: QueryResultCache,
  resultId: string,
  offset = 0,
  limit = 20,
): string {
  const cached = cache.get(resultId);
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

interface PrunableContentPart {
  type?: unknown;
  text?: unknown;
}

interface PrunableToolResult {
  type: "tool_result";
  content: PrunableContentPart[] | string;
}

function isToolResult(value: unknown): value is PrunableToolResult {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "tool_result" && "content" in value;
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
      if (!isToolResult(block) || !Array.isArray(block.content)) continue;
      if (!block.content.some((part) => part?.type === "image")) continue;
      const text = block.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join(" ");
      block.content = text ? `${text}\n${PLACEHOLDER}` : PLACEHOLDER;
    }
  }
}
