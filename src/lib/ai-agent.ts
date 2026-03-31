/**
 * AI Agent — Claude-powered data analyst for the DuckDB shell.
 * Uses raw fetch + SSE parsing (no SDK dependency).
 * Provides tools: run_sql, read_query_results, list_tables, describe_table, ask_user.
 */

import type { CatalogData } from "./service";
import { getColumns, getForeignKeys } from "./service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[] | ToolResultBlock[];
}

interface ContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: any;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface AgentCallbacks {
  onText: (chunk: string) => void;
  onToolCall: (name: string, input: any) => void;
  onToolResult: (name: string, summary: string) => void;
  onDone: (usage?: { inputTokens: number; outputTokens: number }) => void;
  onError: (error: string) => void;
}

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
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "run_sql",
    description: "Execute a DuckDB SQL query against the connected database. Returns results as JSON with columns, types, first 20 rows, total row count, and a result_id for paging. Use standard DuckDB 1.5.1 SQL syntax.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL query to execute" },
      },
      required: ["sql"],
    },
  },
  {
    name: "read_query_results",
    description: "Read additional rows from a previous query result. Use this to page through large result sets without re-executing the query.",
    input_schema: {
      type: "object",
      properties: {
        result_id: { type: "string", description: "Result ID from a previous run_sql response" },
        offset: { type: "number", description: "Row offset to start reading from (default 0)" },
        limit: { type: "number", description: "Max rows to return (default 20, max 100)" },
      },
      required: ["result_id"],
    },
  },
  {
    name: "list_tables",
    description: "List all available tables and views in the database with their schema, type (table/view), description, and column count.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "describe_table",
    description: "Get detailed column information for a table or view: column name, DuckDB type, whether it's nullable, and the column's description/comment.",
    input_schema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name (e.g., 'property')" },
        table: { type: "string", description: "Table or view name (e.g., 'parcels')" },
      },
      required: ["schema", "table"],
    },
  },
  {
    name: "ask_user",
    description: "Present a question with numbered options to the user and wait for their selection. Use this when you need the user to make a choice between specific options.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "List of options for the user to choose from",
        },
      },
      required: ["question", "options"],
    },
  },
];

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

export function buildSystemPrompt(catalog: CatalogData, serviceUrl: string): string {
  const lines: string[] = [
    `You are a data analyst assistant connected to a DuckDB 1.5.1 database via VGI (Vector Gateway Interface).`,
    `Catalog: ${catalog.catalogName}`,
    `Connected via: ${serviceUrl}`,
    ``,
    `Loaded extensions: json, icu, spatial`,
    `Geometry columns are WGS84 (EPSG:4326) in WKB format. Coordinates are longitude/latitude in degrees.`,
    `IMPORTANT: ST_Area, ST_Distance, ST_Length operate in the geometry's CRS. Since geometries are WGS84, these return degrees, NOT meters.`,
    `For real-world distances/areas use ST_Area_Spheroid(geom), ST_Distance_Spheroid(geom1, geom2), ST_Length_Spheroid(geom) which return meters.`,
    `Alternatively, transform to a projected CRS first: ST_Transform(geom, 'EPSG:4326', 'EPSG:32617') for UTM zone 17N (Virginia area).`,
    ``,
    `Available tables and views:`,
  ];

  for (const schema of catalog.schemas) {
    const schemaComment = schema.info.comment ? ` — ${schema.info.comment}` : "";
    lines.push(`  Schema: ${schema.info.name}${schemaComment}`);

    for (const table of schema.tables) {
      const cols = getColumns(table);
      const comment = table.comment ? ` — ${table.comment}` : "";
      lines.push(`    ${schema.info.name}.${table.name} (table, ${cols.length} cols)${comment}`);
    }

    for (const view of schema.views) {
      const comment = view.comment ? ` — ${view.comment}` : "";
      lines.push(`    ${schema.info.name}.${view.name} (view)${comment}`);
    }
  }

  lines.push(``);
  lines.push(`The current database is set to USE ${catalog.catalogName}, so you can query tables without the catalog prefix (e.g., schema.table).`);
  lines.push(`The ${catalog.catalogName} catalog is read-only. To create new tables, use the memory.main catalog and schema (e.g., CREATE TABLE memory.main.my_table AS ...).`);
  lines.push(``);
  lines.push(`Use describe_table to see column details before writing queries.`);
  lines.push(`Use run_sql to execute DuckDB SQL queries.`);
  lines.push(`Use ask_user when you need the user to choose between specific options.`);
  lines.push(`Explain your findings in plain language.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

function truncate(val: any, maxLen = 200): string {
  if (val === null || val === undefined) return "NULL";
  const s = typeof val === "object" ? JSON.stringify(val) : String(val);
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

export function formatArrowTableAsJson(
  table: any,
  maxRows = 20
): { json: string; resultId: string } {
  const fields = table.schema.fields;
  const columns = fields.map((f: any) => f.name);
  const types = fields.map((f: any) => f.type?.toString() || "unknown");
  const numRows = table.numRows;
  const limit = Math.min(maxRows, numRows);

  const rows: Record<string, any>[] = [];
  for (let r = 0; r < limit; r++) {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      const val = table.getChildAt(c)?.get(r);
      row[columns[c]] = val instanceof Uint8Array ? "[binary]" : truncate(val);
    }
    rows.push(row);
  }

  // Cache full result
  const allRows: Record<string, any>[] = [];
  for (let r = 0; r < numRows; r++) {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      const val = table.getChildAt(c)?.get(r);
      row[columns[c]] = val instanceof Uint8Array ? "[binary]" : truncate(val);
    }
    allRows.push(row);
  }
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

export function executeListTables(catalog: CatalogData): string {
  const items: any[] = [];
  for (const schema of catalog.schemas) {
    for (const table of schema.tables) {
      const cols = getColumns(table);
      items.push({
        schema: schema.info.name,
        name: table.name,
        type: "table",
        comment: table.comment || null,
        columns: cols.length,
      });
    }
    for (const view of schema.views) {
      items.push({
        schema: schema.info.name,
        name: view.name,
        type: "view",
        comment: view.comment || null,
      });
    }
  }
  return JSON.stringify(items);
}

export function executeDescribeTable(catalog: CatalogData, schemaName: string, tableName: string): string {
  const schema = catalog.schemas.find((s) => s.info.name === schemaName);
  if (!schema) return JSON.stringify({ error: `Schema '${schemaName}' not found` });

  const table = schema.tables.find((t) => t.name === tableName);
  const view = schema.views.find((v) => v.name === tableName);
  const target = table || view;
  if (!target) return JSON.stringify({ error: `Table or view '${tableName}' not found in schema '${schemaName}'` });

  if (table) {
    const cols = getColumns(table);
    const fks = getForeignKeys(table);

    // Build FK lookup: column name → reference info
    const fkByCol = new Map<string, { referencedSchema: string; referencedTable: string; referencedColumn: string }>();
    for (const fk of fks) {
      for (let i = 0; i < fk.columns.length; i++) {
        fkByCol.set(fk.columns[i], {
          referencedSchema: fk.referencedSchema,
          referencedTable: fk.referencedTable,
          referencedColumn: fk.referencedColumns[i] || fk.columns[i],
        });
      }
    }

    // Primary key column indices → names
    const pkColumns = table.primaryKeyConstraints.flatMap((pk) =>
      pk.map((idx) => cols[idx]?.name).filter(Boolean)
    );

    // Unique constraint column indices → names
    const uniqueConstraints = table.uniqueConstraints.map((uq) =>
      uq.map((idx) => cols[idx]?.name).filter(Boolean)
    ).filter((uq) => uq.length > 0);

    // Not-null set
    const notNullSet = new Set(table.notNullConstraints);

    return JSON.stringify({
      schema: schemaName,
      name: tableName,
      type: "table",
      comment: table.comment || null,
      primary_key: pkColumns.length > 0 ? pkColumns : null,
      unique_constraints: uniqueConstraints.length > 0 ? uniqueConstraints : null,
      check_constraints: table.checkConstraints.length > 0 ? table.checkConstraints : null,
      columns: cols.map((c, i) => {
        const col: any = {
          name: c.name,
          type: c.duckdbType,
          nullable: c.nullable,
          not_null: notNullSet.has(i),
          comment: c.comment || null,
        };
        if (c.defaultValue) col.default = c.defaultValue;
        const fkRef = fkByCol.get(c.name);
        if (fkRef) col.references = `${fkRef.referencedSchema}.${fkRef.referencedTable}(${fkRef.referencedColumn})`;
        if (pkColumns.includes(c.name)) col.primary_key = true;
        return col;
      }),
    });
  }

  // View — less metadata available
  return JSON.stringify({
    schema: schemaName,
    name: tableName,
    type: "view",
    comment: view!.comment || null,
  });
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
// SSE stream parser
// ---------------------------------------------------------------------------

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent turn — one full request/response cycle with streaming
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  callbacks: AgentCallbacks,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err: any) {
      // Network error (offline, DNS failure, CORS, connection reset)
      if (init.signal?.aborted) throw new Error("Cancelled.");
      if (attempt < maxRetries) {
        const waitSec = Math.min(2 ** attempt * 2, 10);
        for (let remaining = waitSec; remaining > 0; remaining--) {
          if (init.signal?.aborted) throw new Error("Cancelled.");
          callbacks.onText(`\r\x1b[2m(Network error, retrying in ${remaining}s...)\x1b[0m\x1b[K`);
          await new Promise((r) => setTimeout(r, 1000));
        }
        callbacks.onText(`\r\x1b[K`);
        continue;
      }
      throw new Error("Network error. Check your connection.");
    }

    if (response.ok) return response;

    const status = response.status;
    let errorMsg: string;
    try {
      const body = await response.json();
      errorMsg = body.error?.message || JSON.stringify(body);
    } catch {
      errorMsg = response.statusText;
    }

    // Don't retry auth errors
    if (status === 401 || status === 403) throw new Error("Invalid API key. Check Settings.");

    // Retry on rate limit (429) and overloaded (529)
    if ((status === 429 || status === 529) && attempt < maxRetries) {
      const retryAfter = response.headers.get("retry-after");
      const waitSec = retryAfter ? Math.min(parseInt(retryAfter, 10) || 5, 30) : Math.min(2 ** attempt * 2, 15);
      for (let remaining = waitSec; remaining > 0; remaining--) {
        if (init.signal?.aborted) throw new Error("Cancelled.");
        callbacks.onText(`\r\x1b[2m(Rate limited, retrying in ${remaining}s...)\x1b[0m\x1b[K`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      callbacks.onText(`\r\x1b[K`); // Clear countdown line
      continue;
    }

    if (status === 429) throw new Error("Rate limited. Try again shortly.");
    if (status === 529) throw new Error("Claude is busy. Try again shortly.");
    throw new Error(`API error (${status}): ${errorMsg}`);
  }

  throw new Error("Max retries exceeded.");
}

async function streamOneRequest(
  apiKey: string,
  model: string,
  messages: MessageParam[],
  systemPrompt: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal
): Promise<{ content: ContentBlock[]; stopReason: string; inputTokens: number; outputTokens: number }> {
  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOLS,
        system: systemPrompt,
        max_tokens: 4096,
        stream: true,
      }),
      signal,
    },
    callbacks
  );

  const reader = response.body!.getReader();
  const content: ContentBlock[] = [];
  let currentBlock: ContentBlock | null = null;
  let currentToolInput = "";
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of parseSSEStream(reader, signal)) {
    if (event.type === "message_start" && event.message?.usage) {
      inputTokens = event.message.usage.input_tokens || 0;
    } else if (event.type === "content_block_start") {
      if (event.content_block.type === "text") {
        currentBlock = { type: "text", text: "" };
      } else if (event.content_block.type === "tool_use") {
        currentBlock = {
          type: "tool_use",
          id: event.content_block.id,
          name: event.content_block.name,
          input: {},
        };
        currentToolInput = "";
      }
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta" && currentBlock?.type === "text") {
        currentBlock.text += event.delta.text;
        callbacks.onText(event.delta.text);
      } else if (event.delta.type === "input_json_delta") {
        currentToolInput += event.delta.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      if (currentBlock) {
        if (currentBlock.type === "tool_use") {
          try {
            currentBlock.input = JSON.parse(currentToolInput);
          } catch {
            currentBlock.input = {};
          }
        }
        content.push(currentBlock);
        currentBlock = null;
      }
    } else if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason || stopReason;
      if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
    }
  }

  return { content, stopReason, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Public API — run a full agent turn (may loop for tool calls)
// ---------------------------------------------------------------------------

export async function runAgentTurn(
  apiKey: string,
  model: string,
  messages: MessageParam[],
  systemPrompt: string,
  executeTool: (name: string, input: any) => Promise<string>,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  maxToolRounds = 20
): Promise<void> {
  const MAX_TOOL_ROUNDS = maxToolRounds;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return;

    const { content, stopReason, inputTokens, outputTokens } = await streamOneRequest(
      apiKey, model, messages, systemPrompt, callbacks, signal
    );
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    // Add assistant response to history
    messages.push({ role: "assistant", content });

    if (stopReason !== "tool_use") {
      callbacks.onDone({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
      return;
    }

    // Execute tool calls
    const toolResults: ToolResultBlock[] = [];
    for (const block of content) {
      if (block.type === "tool_use" && block.id && block.name) {
        callbacks.onToolCall(block.name, block.input);
        try {
          const result = await executeTool(block.name, block.input);
          callbacks.onToolResult(block.name, result.length > 200 ? result.slice(0, 200) + "…" : result);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        } catch (err: any) {
          const errMsg = err instanceof Error ? err.message : String(err);
          callbacks.onToolResult(block.name, `Error: ${errMsg}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: errMsg,
            is_error: true,
          });
        }
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  callbacks.onError("Too many tool rounds. Try a simpler question.");
  callbacks.onDone();
}

export { TOOLS, type MessageParam, type ContentBlock, type ToolResultBlock };
