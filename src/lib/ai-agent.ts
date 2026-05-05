/**
 * AI Agent — Claude-powered data analyst for the DuckDB shell.
 * Uses raw fetch + SSE parsing (no SDK dependency).
 * Provides tools: run_sql, read_query_results, list_tables, describe_table, ask_user.
 */

import type { CatalogData } from "./service";
import { getColumns, getForeignKeys } from "./service";
import { filterTagsForAI, TAG_DESCRIPTION_LLM, TAG_DESCRIPTION_MD, TAG_EXAMPLE_QUERIES } from "./tags";

// TEMP: keep in sync with the extension list in public/shell/worker.js.
// Flip to true to re-enable spatial-aware prompting once the extension is loaded again.
const SPATIAL_ENABLED = false;

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
  /** Called during retry countdowns with the status message, or null when countdown ends. */
  onRetry?: (message: string | null) => void;
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
    description: "List all schemas, tables, and views in the database. Returns catalog name, schema names with comments and tags, and each table/view with comment, column count, and tags.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "describe_table",
    description: "Get detailed information for a table or view: columns (name, type, nullable, comment, default, FK references), primary key, foreign keys, unique constraints, check constraints, and tags.",
    input_schema: {
      type: "object",
      properties: {
        catalog: { type: "string", description: "Catalog name (e.g., 'airports', 'memory'). Defaults to the current catalog if omitted." },
        schema: { type: "string", description: "Schema name (e.g., 'airports', 'main')" },
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

export function buildSystemPrompt(catalog: CatalogData, serviceUrl: string, memoryCatalog?: CatalogData | null): string {
  const cat = catalog.catalogName;
  const firstSchema = catalog.schemas[0]?.info.name || "schema";
  const firstTable = catalog.schemas[0]?.tables[0]?.name || "table";
  const exFull = `${cat}.${firstSchema}.${firstTable}`;

  const lines: string[] = [
    `You are a data analyst assistant connected to a DuckDB 1.5.1 database.`,
    ``,
    `## Tools`,
    `* **describe_table** — Get column names, types, and descriptions for a table.`,
    `* **run_sql** — Execute a DuckDB SQL query.`,
    `* **ask_user** — Ask the user to choose between specific options.`,
    ``,
    `## Rules`,
    ``,
    `### Before writing any query`,
    `You MUST call describe_table for every table you plan to reference. Do not guess or infer column names from the table description — they are not predictable.`,
    ``,
    `### Query planning`,
    `For multi-step or ambiguous questions, outline your analysis plan first: which tables, what joins, what aggregations. Then execute step by step using CTEs, views, or temporary tables to break complex work into stages.`,
    ``,
    `### SQL style`,
    `* Always use fully qualified three-part table references: \`catalog.schema.table\` (e.g., \`${exFull}\`). Never use bare table names or two-part names — even if a default catalog or schema is set.`,
    `* Use short aliases to keep queries readable: \`FROM ${exFull} t\`.`,
    `* Always JOIN tables in SQL rather than combining results from separate queries in prose.`,
    `* All arithmetic, aggregation, and numeric comparison MUST happen in SQL via run_sql. Never do math in your head.`,
    `* For final results, select only the columns relevant to the user's question — avoid \`SELECT *\`.`,
    `* Prefer CTEs (\`WITH\` clauses) for intermediate steps within a single query. Use views for reusable filtered subsets. Use \`CREATE TABLE\` only when you need to materialize data.`,
    ``,
    `### Disambiguation`,
    `Use ask_user when the user's question is ambiguous — e.g., which item, which metric, which time period. Don't assume.`,
    ``,
    `### Error recovery`,
    `If a query fails, look up every function used: \`SELECT function_name, parameters, description FROM duckdb_functions() WHERE function_name = 'name'\`. If the same error occurs twice, explain the issue to the user and ask for guidance — do not retry indefinitely.`,
    ``,
    `### Output`,
    `* For results ≤20 rows: show as a formatted table.`,
    `* For results >20 rows: summarize key findings and show a representative sample.`,
    `* For wide results (>6 columns): select only the relevant columns rather than dumping everything.`,
    `* Always explain your findings in plain language after presenting data.`,
    ``,
    `### Never do this`,
    `* Never use \`SELECT *\` in result queries.`,
    `* Never perform arithmetic outside SQL.`,
    `* Never combine results from separate queries in prose — use JOINs or CTEs.`,
    `* Never use two-part or bare table names — always use \`catalog.schema.table\`.`,
    ...(SPATIAL_ENABLED ? [`* Never use \`ST_Area()\`, \`ST_Distance()\`, or \`ST_Length()\` for real-world measurements (see Spatial section below).`] : []),
    `* Never attempt to LOAD or INSTALL extensions. Only the loaded extensions listed below are available.`,
    ``,
    `## Object naming: catalog → schema → table`,
    ``,
    `DuckDB uses a three-level namespace: \`catalog.schema.table\`.`,
    ``,
    `| Level | What it is | Example |`,
    `|-------|-----------|---------|`,
    `| Catalog | A database or attached data source | \`${cat}\`, \`memory\` |`,
    `| Schema | A grouping of related tables within a catalog | \`${cat}.${firstSchema}\` |`,
    `| Table | A single table or view | \`${exFull}\` |`,
    ``,
    `Always use fully qualified three-part names. This is non-negotiable — queries that omit the catalog or schema will break when multiple catalogs are attached.`,
    ``,
    `\`\`\`sql`,
    `-- WRONG: bare or two-part names`,
    `SELECT * FROM ${firstTable};`,
    `SELECT * FROM ${firstSchema}.${firstTable};`,
    ``,
    `-- RIGHT: fully qualified three-part name`,
    `SELECT * FROM ${exFull};`,
    `\`\`\``,
    ``,
    `## The memory catalog`,
    ``,
    `All attached data catalogs are read-only. To persist derived results, write to the memory catalog:`,
    ``,
    `\`\`\`sql`,
    `CREATE TABLE memory.main.my_table AS SELECT ...;`,
    `COMMENT ON TABLE memory.main.my_table IS 'What this table contains';`,
    `\`\`\``,
    ``,
    `For simple filters with no aggregation, prefer a view — it stays current and costs nothing:`,
    ``,
    `\`\`\`sql`,
    `CREATE VIEW memory.main.my_view AS`,
    `  SELECT * FROM ${exFull} WHERE ...;`,
    `\`\`\``,
    ``,
    `Always use fully qualified three-part source names inside view definitions — views don't inherit any default catalog or schema context.`,
    ``,
    `## Attached catalogs`,
    ``,
    `### ${cat}`,
    `Loaded extensions: json, icu${SPATIAL_ENABLED ? ", spatial" : ""}`,
  ];

  // Catalog-level description for AI context
  if (catalog.catalogTags?.[TAG_DESCRIPTION_LLM]) {
    lines.push(`## Catalog Description`);
    lines.push(catalog.catalogTags[TAG_DESCRIPTION_LLM]);
    lines.push(``);
  }

  // Dynamic catalog content
  for (const schema of catalog.schemas) {
    const schemaComment = schema.info.comment ? ` — ${schema.info.comment}` : "";
    const filteredTags = schema.info.tags
      ? Object.entries(schema.info.tags).filter(([k]) => ![TAG_EXAMPLE_QUERIES, TAG_DESCRIPTION_MD].includes(k))
      : [];
    const schemaTags = filteredTags.length > 0
      ? ` [${filteredTags.map(([k, v]) => `${k}: ${v}`).join(", ")}]` : "";
    lines.push(`**Schema: ${cat}.${schema.info.name}**${schemaComment}${schemaTags}`);

    for (const table of schema.tables) {
      const comment = table.comment ? ` — ${table.comment}` : "";
      lines.push(`* \`${cat}.${schema.info.name}.${table.name}\`${comment}`);
    }

    for (const view of schema.views) {
      const comment = view.comment ? ` — ${view.comment}` : "";
      lines.push(`* \`${cat}.${schema.info.name}.${view.name}\`${comment}`);
    }

    if (schema.macros?.length > 0) {
      for (const macro of schema.macros) {
        const comment = macro.comment ? ` — ${macro.comment}` : "";
        const params = macro.parameters.length > 0 ? `(${macro.parameters.join(", ")})` : "()";
        lines.push(`* \`${cat}.${schema.info.name}.${macro.name}${params}\` (${macro.macro_type} macro)${comment}`);
      }
    }
    lines.push(``);
  }

  // Memory catalog tables (if any exist)
  if (memoryCatalog && memoryCatalog.schemas.some(s => s.tables.length > 0 || s.views.length > 0)) {
    lines.push(`### memory (in-memory tables)`);
    lines.push(`These are user-created tables and views in the writable memory catalog.`);
    lines.push(``);
    for (const schema of memoryCatalog.schemas) {
      const hasTables = schema.tables.length > 0 || schema.views.length > 0;
      if (!hasTables) continue;
      lines.push(`**Schema: memory.${schema.info.name}**`);
      for (const table of schema.tables) {
        const comment = table.comment ? ` — ${table.comment}` : "";
        lines.push(`* \`memory.${schema.info.name}.${table.name}\`${comment}`);
      }
      for (const view of schema.views) {
        const comment = view.comment ? ` — ${view.comment}` : "";
        lines.push(`* \`memory.${schema.info.name}.${view.name}\`${comment}`);
      }
      lines.push(``);
    }
  }

  // Spatial section
  if (SPATIAL_ENABLED) {
    lines.push(`## Spatial data (${cat} catalog)`);
    lines.push(``);
    lines.push(`Geometry columns are WGS84 (EPSG:4326) in WKB format. Coordinates are longitude/latitude in degrees.`);
    lines.push(``);
    lines.push(`| Need | Wrong (degrees) | Right (meters) |`);
    lines.push(`|------|----------------|----------------|`);
    lines.push(`| Distance | \`ST_Distance\` | \`ST_Distance_Spheroid\` |`);
    lines.push(`| Area | \`ST_Area\` | \`ST_Area_Spheroid\` |`);
    lines.push(`| Length | \`ST_Length\` | \`ST_Length_Spheroid\` |`);
    lines.push(``);
    lines.push(`Alternative: transform to a projected CRS first, then use the plain functions:`);
    lines.push(`\`ST_Transform(geom, 'EPSG:4326', 'EPSG:32617')\` — UTM zone 17N`);
  }

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

/** Format an Arrow field value, converting Date/Timestamp/Time epochs and BigInt. */
function formatFieldVal(val: any, field: any): any {
  if (val === null || val === undefined) return null;
  if (val instanceof Uint8Array) return "[binary]";
  const typeStr: string = field.type?.toString() || "";
  const num = typeof val === "bigint" ? Number(val) : val;
  if (typeof num === "number" && !isNaN(num)) {
    if (typeStr.startsWith("Date")) {
      const d = new Date(num);
      if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    }
    if (typeStr.startsWith("Timestamp")) {
      const d = new Date(num);
      if (!isNaN(d.getTime())) {
        const s = d.toISOString().replace("T", " ").replace("Z", "");
        return s.endsWith(".000") ? s.slice(0, -4) : s;
      }
    }
    if (typeStr.startsWith("Time")) {
      const totalSec = Math.floor(num / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }
  if (typeof val === "bigint") return val.toString();
  return truncate(val);
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
      row[columns[c]] = formatFieldVal(table.getChildAt(c)?.get(r), fields[c]);
    }
    rows.push(row);
  }

  // Cache result (capped to prevent OOM on large tables)
  const CACHE_LIMIT = 10_000;
  const rowsToCache = Math.min(numRows, CACHE_LIMIT);
  const allRows: Record<string, any>[] = [];
  for (let r = 0; r < rowsToCache; r++) {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      row[columns[c]] = formatFieldVal(table.getChildAt(c)?.get(r), fields[c]);
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
  const result: any = {
    catalog: catalog.catalogName,
    default_schema: catalog.defaultSchema,
    schemas: catalog.schemas.map((schema) => {
      const schemaInfo: any = {
        name: schema.info.name,
        comment: schema.info.comment || null,
      };
      const schemaTags = filterTagsForAI(schema.info.tags);
      if (schemaTags) schemaInfo.tags = schemaTags;
      schemaInfo.tables = schema.tables.map((table) => {
        const cols = getColumns(table);
        const entry: any = {
          name: table.name,
          type: "table",
          comment: table.comment || null,
          columns: cols.length,
        };
        const tTags = filterTagsForAI(table.tags);
        if (tTags) entry.tags = tTags;
        return entry;
      });
      schemaInfo.views = schema.views.map((view) => {
        const entry: any = {
          name: view.name,
          type: "view",
          comment: view.comment || null,
        };
        const vTags = filterTagsForAI(view.tags);
        if (vTags) entry.tags = vTags;
        return entry;
      });
      if (schema.macros?.length > 0) {
        schemaInfo.macros = schema.macros.map((macro) => ({
          name: macro.name,
          type: macro.macro_type === "TABLE" ? "table_macro" : "scalar_macro",
          parameters: macro.parameters,
          comment: macro.comment || null,
        }));
      }
      return schemaInfo;
    }),
  };
  return JSON.stringify(result);
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
    const pkColumns = (table.primary_key_constraints ?? []).flatMap((pk) =>
      pk.map((idx: number) => cols[idx]?.name).filter(Boolean)
    );

    // Unique constraint column indices → names
    const uniqueConstraints = table.unique_constraints.map((uq) =>
      uq.map((idx: number) => cols[idx]?.name).filter(Boolean)
    ).filter((uq) => uq.length > 0);

    // Not-null set
    const notNullSet = new Set<number>(table.not_null_constraints);

    // FK summary at table level
    const foreignKeys = fks.map((fk) => ({
      columns: fk.columns,
      references: `${fk.referencedSchema}.${fk.referencedTable}(${fk.referencedColumns.join(", ")})`,
    }));

    return JSON.stringify({
      schema: schemaName,
      name: tableName,
      type: "table",
      comment: table.comment || null,
      tags: filterTagsForAI(table.tags),
      primary_key: pkColumns.length > 0 ? pkColumns : null,
      foreign_keys: foreignKeys.length > 0 ? foreignKeys : null,
      unique_constraints: uniqueConstraints.length > 0 ? uniqueConstraints : null,
      check_constraints: table.check_constraints.length > 0 ? table.check_constraints : null,
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
    tags: filterTagsForAI(view!.tags),
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
        } catch (e) {
          console.warn("SSE parse error:", data.slice(0, 200), e);
        }
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
        let interrupted = false;
        for (let remaining = waitSec; remaining > 0; remaining--) {
          if (init.signal?.aborted) { interrupted = true; break; }
          callbacks.onRetry?.(`Network error, retrying in ${remaining}s...`);
          await new Promise((r) => setTimeout(r, 1000));
        }
        callbacks.onRetry?.(null);
        if (interrupted) continue; // abort during wait → skip to next attempt (will abort on fetch)
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

    // Don't retry auth or not-found errors
    if (status === 401 || status === 403) throw new Error("Invalid API key. Check Settings.");
    if (status === 404) throw new Error(`API endpoint not found (404). Check your API configuration.`);

    // Retry on rate limit (429) and overloaded (529)
    if ((status === 429 || status === 529) && attempt < maxRetries) {
      const retryAfter = response.headers.get("retry-after");
      const waitSec = retryAfter ? Math.min(parseInt(retryAfter, 10) || 5, 30) : Math.min(2 ** attempt * 2, 15);
      let interrupted = false;
      for (let remaining = waitSec; remaining > 0; remaining--) {
        if (init.signal?.aborted) { interrupted = true; break; }
        callbacks.onRetry?.(`Rate limited, retrying in ${remaining}s...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      callbacks.onRetry?.(null);
      if (interrupted) continue; // abort during wait → skip retry, re-enter loop (will abort on next fetch)
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
        "anthropic-beta": "prompt-caching-2024-07-31",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOLS.map((t, i) =>
          i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
        ),
        system: [
          { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ],
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

    // Retry streamOneRequest on network errors (stream disconnect, fetch failure)
    let result: { content: ContentBlock[]; stopReason: string; inputTokens: number; outputTokens: number } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await streamOneRequest(
          apiKey, model, messages, systemPrompt, callbacks, signal
        );
        break;
      } catch (err: any) {
        const msg = err?.message?.toLowerCase() || "";
        const isNetworkError = msg.includes("network") || msg.includes("failed to fetch") || msg.includes("load failed") || msg.includes("aborted");
        if (isNetworkError && !signal?.aborted && attempt < 2) {
          const waitSec = Math.min(2 ** attempt * 2, 10);
          for (let remaining = waitSec; remaining > 0; remaining--) {
            if (signal?.aborted) throw err;
            if (callbacks.onRetry) {
              callbacks.onRetry(`Network error, retrying in ${remaining}s...`);
            } else {
              callbacks.onText(`\r\x1b[2m(Network error, retrying in ${remaining}s...)\x1b[0m\x1b[K`);
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (callbacks.onRetry) {
            callbacks.onRetry(null);
          } else {
            callbacks.onText(`\r\x1b[K`);
          }
          continue;
        }
        throw err;
      }
    }
    if (!result) throw new Error("Network error. Check your connection.");

    const { content, stopReason, inputTokens, outputTokens } = result;
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

          // Fatal errors (e.g., VGI server crash) — abort the agent loop entirely
          if ((err as any).fatal) {
            callbacks.onError(`Connection error — agent stopped. ${errMsg}`);
            callbacks.onDone({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
            return;
          }

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
