/**
 * AI Agent — Claude-powered data analyst for the DuckDB shell.
 * Uses raw fetch + SSE parsing (no SDK dependency).
 * Provides tools: run_sql, read_query_results, list_tables, describe_table,
 * ask_user.
 */

import * as Sentry from "@sentry/astro";

/** The span object Sentry hands to a `startSpan` callback. Derived from the
 *  API we actually call rather than written as `Sentry.Span` — @sentry/astro
 *  re-exports `Span` as a value only, so naming it directly is a type error,
 *  and the concrete type has moved between SDK majors. */
type AgentSpan = Parameters<Parameters<typeof Sentry.startSpan>[1]>[0];

import type { CatalogData } from "./service";
import { getColumns, getForeignKeys } from "./service";
import { filterTagsForAI, filterTagsForAIDetail, getTag, parseCategories, TAG_CATEGORY } from "./tags";
import { formatFunctionSignature, getFunctionArgs, getFunctionReturn } from "./function-info";
import { fetchWithRetry } from "./ai-fetch";
import {
  AGENT_NAME,
  ATTR,
  isAbortError,
  isAiTelemetryEnabled,
  mapUsageAttributes,
  serializeInputMessages,
  serializeOutputMessages,
  serializeToolDefinitions,
  serializeToolResult,
} from "./ai-telemetry";

// Spatial guidance is emitted only when the spatial extension ACTUALLY loaded
// this session. It used to be `const SPATIAL_ENABLED = true` with a comment
// asking the reader to keep it in sync with shell-init by hand — so when a
// non-required extension failed to install (which shell-init tolerates and
// continues past), the prompt still told the model spatial was available and
// it would emit ST_* calls that error.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageParam {
  role: "user" | "assistant";
  /** A single array may legitimately MIX block kinds — `mergeAdjacentSameRole`
   *  folds a trailing user question into the preceding tool_result message, so
   *  the result holds `tool_result` and `text` blocks side by side. The older
   *  `ContentBlock[] | ToolResultBlock[]` couldn't express that and forced a
   *  false cast at the merge site. */
  content: string | Array<ContentBlock | ToolResultBlock>;
}

interface ContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: any;
}

/** Content fragments that may appear inside a multi-part tool_result.
 *  Anthropic accepts `content: string` OR `content: ToolResultContent[]`.
 *  The array form is what enables image-in-tool-result — used by
 *  render_chart to feed the rendered PNG back to the agent. */
export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };

/** What a tool implementation may return. A plain string is the common case
 *  (everything except render_chart); the array form is used when an image
 *  needs to ride along with the text response. */
export type ToolResult = string | ToolResultContent[];

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResult;
  is_error?: boolean;
}

interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface SystemPromptBlock {
  text: string;
  /** Write an explicit cache entry at the end of this stable prefix. */
  cacheControl?: boolean;
}

export type SystemPrompt = string | SystemPromptBlock[];
export type AgentTelemetryMode = boolean | "usage";

export interface AgentCacheDiagnostics {
  messageId?: string;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Anthropic's beta diagnostic payload; null means no divergence. */
  diagnostics?: unknown;
}

export interface AgentCallbacks {
  onText: (chunk: string) => void;
  /** The model has started streaming a tool_use block's input JSON. Fires at
   *  content_block_start, i.e. BEFORE the arguments have finished arriving —
   *  onToolCall can't stand in for it, since that only fires once the whole
   *  response has streamed and the dispatch loop reaches the call. Long inputs
   *  (a big SQL statement, a Vega spec) spend seconds in this window, and a
   *  surface that clears its indicator on the first text delta would otherwise
   *  show nothing at all for the duration. */
  onToolInputStart?: (name: string) => void;
  onToolCall: (name: string, input: any) => void;
  onToolResult: (name: string, summary: string) => void;
  onDone: (usage?: AgentUsage) => void;
  onError: (error: string) => void;
  /** Development-only cache diagnostics, enabled with
   *  window.__cupolaAiCacheDiagnostics = true before starting a turn. */
  onCacheDiagnostics?: (diagnostics: AgentCacheDiagnostics) => void;
  /** Called during retry countdowns with the status message, or null when countdown ends. */
  onRetry?: (message: string | null) => void;
}

// Query-result serialization + caching lives in ./query-results (depends only on the pure
// ./format helpers, so it stays unit-testable without the VGI/service import graph).
// Re-exported here so existing `from "./ai-agent"` import sites keep working.
export { formatArrowTableAsJson, executeReadQueryResults } from "./query-results";
import { pruneCarriedToolImages } from "./query-results";
import { recordToolCall, repeatedCallMessage } from "./ai-loop-guard";
import { parseStreamedToolInput } from "./tool-input";
import { clampMaxTokens, DEFAULT_AI_MAX_TOKENS } from "./ai/model-limits";
import type { AgentUsage } from "./ai-usage";

// ---------------------------------------------------------------------------
// Dev-side tool-call tracing
// ---------------------------------------------------------------------------

/** Gate for the [ai] tool console logs. Default-on; user can silence by
 *  setting `window.__cupolaAiDebug = false` from devtools. */
function aiDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const v = (window as any).__cupolaAiDebug;
  return v !== false;
}

function logToolCall(name: string, input: unknown): void {
  if (!aiDebugEnabled()) return;
  // Use console.groupCollapsed so a chatty session doesn't fill the
  // console with text — each call is one collapsible entry.
  console.groupCollapsed(`%c[ai] → ${name}`, "color:#4a7c23;font-weight:bold");
  try {
    console.log("input:", input);
  } finally {
    console.groupEnd();
  }
}

function logToolResult(name: string, result: ToolResult): void {
  if (!aiDebugEnabled()) return;
  console.groupCollapsed(`%c[ai] ← ${name}`, "color:#2d5016;font-weight:bold");
  try {
    if (typeof result === "string") {
      // Try to parse as JSON for readable inspection; fall back to raw.
      try {
        console.log("result:", JSON.parse(result));
      } catch {
        console.log("result:", result.length > 1000 ? result.slice(0, 1000) + "… (truncated)" : result);
      }
    } else {
      // Array form (multi-part content). Show text parts inline and note
      // image parts by media type / size only — base64 PNGs would flood
      // the console.
      const parts = result.map((p) =>
        p.type === "text"
          ? { type: "text", text: tryJson(p.text) }
          : { type: "image", media_type: p.source.media_type, dataBytes: p.source.data.length }
      );
      console.log("result:", parts);
    }
  } finally {
    console.groupEnd();
  }
}

function logToolError(name: string, errMsg: string): void {
  if (!aiDebugEnabled()) return;
  console.warn(`%c[ai] ✗ ${name}`, "color:#b94a48;font-weight:bold", errMsg);
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "run_sql",
    description: "Execute a SQL query against the connected DuckDB database. Returns results as JSON with columns, types, first 20 rows, total row count, and a result_id for paging.",
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
    name: "list_catalogs",
    description: "List every catalog currently attached to this DuckDB session. Use this before discovery when more than one worker may be attached.",
    input_schema: {
      type: "object",
      properties: {
        cursor: { type: "string", description: "Opaque cursor from the previous response" },
        limit: { type: "number", description: "Maximum catalogs (default 25, max 50)" },
      },
    },
  },
  {
    name: "list_tables",
    description: "Search and page through tables, views, functions, and macros in one attached catalog. When multiple worker catalogs exist, catalog is required.",
    input_schema: {
      type: "object",
      properties: {
        catalog: { type: "string" },
        schema: { type: "string" },
        category: { type: "string" },
        query: { type: "string", description: "Case-insensitive name/comment/tag search" },
        cursor: { type: "string" },
        limit: { type: "number", description: "Default 100, max 200" },
      },
    },
  },
  {
    name: "list_categories",
    description: "List the controlled vgi.categories registry for schemas in one catalog.",
    input_schema: {
      type: "object",
      properties: { catalog: { type: "string" }, schema: { type: "string" } },
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
    name: "describe_function",
    description: "Describe a scalar/table function or macro, including its arguments, constraints, return schema, examples, category, and tags.",
    input_schema: {
      type: "object",
      properties: {
        catalog: { type: "string" },
        schema: { type: "string" },
        function: { type: "string" },
      },
      required: ["schema", "function"],
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

/** Chart tool — only exposed on surfaces that can render charts (AskAIChat).
 *  The terminal `.ai` mode does not include this in its tool set.
 *
 *  The tool dispatcher runs the SQL itself, caches rows, inserts a vega_chart
 *  block, and returns a truthful tool_result (row count + sample). It does NOT
 *  send full rows back to the model (waste of context) — just metadata. */
export const CHART_TOOL: Tool = {
  name: "render_chart",
  description: [
    "Visualize a SQL result as a Vega-Lite chart in the chat. Provide a re-runnable SELECT (the user can refresh, which re-executes it) and a Vega-Lite v5 spec.",
    "DO NOT include a `data` field in the spec — rows from the SQL are injected automatically.",
    "Prefer minimal specs: omit defaults, no inline data values, encode columns by their SQL output names.",
    "**USER-INITIATED ONLY.** Call this tool ONLY when the user explicitly asks for a chart, plot, graph, visualization, histogram, map, scatter, heatmap, etc. For every other question — counts, lookups, comparisons, summaries — return a table or prose answer. Do not infer that a chart 'would help' or volunteer one because the data is plottable.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SELECT statement that produces the chart's PRIMARY rows. Re-run verbatim on refresh.",
      },
      spec: {
        type: "object",
        description: "Vega-Lite v5 JSON spec without `data` or `datasets` fields. The primary SQL result is auto-injected; declare additional datasets via the `extraData` parameter and reference them in layer/concat marks as `data: { name: '...' }`.",
      },
      title: {
        type: "string",
        description: "Optional chart title displayed above the chart.",
      },
      extraData: {
        type: "array",
        maxItems: 5,
        description: "Optional additional named datasets to overlay alongside the primary. Use when you need heterogeneous sources on one chart (e.g. earthquake points + volcano markers; raw data + a reference line). Each entry's `name` is referenced in the spec as `data: { name: '<name>' }` on layer/concat marks. Up to 5 extras per chart.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Dataset name for this extra source. Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ and not be '__cupola_data' (reserved for the primary).",
            },
            sql: {
              type: "string",
              description: "SELECT statement producing the rows for this extra dataset. Re-run on refresh.",
            },
          },
          required: ["name", "sql"],
        },
      },
    },
    required: ["sql", "spec"],
  },
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

// The prompt text lives in ./ai/system-prompt (pure, unit-tested). Re-exported
// here so the existing `from "./ai-agent"` import surface keeps working.
export { buildSystemPrompt } from "./ai/system-prompt";

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

export type CatalogCollection = CatalogData | readonly CatalogData[];

function catalogsOf(value: CatalogCollection): readonly CatalogData[] {
  return Array.isArray(value) ? value : [value as CatalogData];
}

function resolveCatalog(value: CatalogCollection, requested?: string): CatalogData | string {
  const catalogs = catalogsOf(value);
  if (requested) {
    return catalogs.find((catalog) => catalog.catalogName === requested)
      ?? JSON.stringify({ error: `Catalog '${requested}' is not attached`, catalogs: catalogs.map((c) => c.catalogName) });
  }
  const workers = catalogs.filter((catalog) => catalog.catalogName !== "memory");
  if (workers.length === 1) return workers[0];
  if (catalogs.length === 1) return catalogs[0];
  return JSON.stringify({
    error: "Catalog is required because multiple worker catalogs are attached",
    catalogs: workers.map((catalog) => catalog.catalogName),
  });
}

function offsetCursor(cursor: unknown): number {
  const offset = Number(cursor ?? 0);
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

function page<T>(items: T[], cursor: unknown, requestedLimit: unknown, fallback: number, maximum: number) {
  const offset = offsetCursor(cursor);
  const rawLimit = Number(requestedLimit ?? fallback);
  const limit = Math.min(maximum, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback));
  const values = items.slice(offset, offset + limit);
  return { values, next_cursor: offset + limit < items.length ? String(offset + limit) : null, total: items.length };
}

function clipText(value: unknown, limit: number): string | null {
  if (value == null || value === "") return null;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text;
}

const listingText = (value: unknown) => clipText(value, 500);
const detailText = (value: unknown) => clipText(value, 4_000);

export function executeListCatalogs(collection: CatalogCollection, input: any = {}): string {
  const items = catalogsOf(collection).map((catalog, index) => ({
    catalog: catalog.catalogName,
    type: catalog.catalogName === "memory" ? "memory" : "vgi",
    primary: index === 0,
    comment: listingText(catalog.catalogComment),
    tags: filterTagsForAI(catalog.catalogTags),
    schemas: catalog.schemas.length,
    objects: catalog.schemas.reduce(
      (count, schema) => count + schema.tables.length + schema.views.length + schema.functions.length + schema.macros.length,
      0,
    ),
  }));
  const result = page(items, input.cursor, input.limit, 25, 50);
  return JSON.stringify({ catalogs: result.values, total: result.total, next_cursor: result.next_cursor });
}

export function executeListTables(collection: CatalogCollection, input: any = {}): string {
  const resolved = resolveCatalog(collection, input.catalog);
  if (typeof resolved === "string") return resolved;
  const query = String(input.query || "").trim().toLowerCase();
  const items: any[] = [];
  for (const schema of resolved.schemas) {
    if (input.schema && schema.info.name !== input.schema) continue;
    const append = (object: any, type: string, extra: Record<string, unknown> = {}) => {
      const tags = filterTagsForAI(object.tags);
      const category = getTag(object.tags, TAG_CATEGORY);
      if (input.category && category !== input.category) return;
      const entry = {
        catalog: resolved.catalogName,
        schema: schema.info.name,
        name: object.name,
        qualified_name: `${resolved.catalogName}.${schema.info.name}.${object.name}`,
        type,
        comment: listingText(object.comment || object.description),
        category: category || null,
        ...(tags ? { tags } : {}),
        ...extra,
      };
      if (query && !JSON.stringify(entry).toLowerCase().includes(query)) return;
      items.push(entry);
    };
    schema.tables.forEach((table) => append(table, "table", { columns: getColumns(table).length }));
    schema.views.forEach((view) => append(view, "view"));
    schema.functions.forEach((func) => append(func, "function", { signature: formatFunctionSignature(func) }));
    schema.macros.forEach((macro) => append(macro, macro.macro_type === "TABLE" ? "table_macro" : "scalar_macro", { parameters: macro.parameters }));
  }
  const result = page(items, input.cursor, input.limit, 100, 200);
  return JSON.stringify({
    catalog: resolved.catalogName,
    default_schema: resolved.defaultSchema,
    schemas: resolved.schemas
      .filter((schema) => !input.schema || schema.info.name === input.schema)
      .map((schema) => ({
        catalog: resolved.catalogName,
        name: schema.info.name,
        comment: listingText(schema.info.comment),
        tags: filterTagsForAI(schema.info.tags),
      })),
    objects: result.values,
    total: result.total,
    next_cursor: result.next_cursor,
  });
}

export function executeListCategories(collection: CatalogCollection, input: any = {}): string {
  const resolved = resolveCatalog(collection, input.catalog);
  if (typeof resolved === "string") return resolved;
  const schemas = resolved.schemas
    .filter((schema) => !input.schema || schema.info.name === input.schema)
    .map((schema) => ({
      catalog: resolved.catalogName,
      schema: schema.info.name,
      categories: parseCategories(schema.info.tags).map((category) => ({
        ...category,
        description: detailText(category.description) || undefined,
        doc_md: detailText(category.doc_md) || undefined,
      })),
    }));
  if (input.schema && schemas.length === 0) return JSON.stringify({ error: `Schema '${input.schema}' not found`, catalog: resolved.catalogName });
  return JSON.stringify({ catalog: resolved.catalogName, schemas });
}

export function executeDescribeTable(
  collection: CatalogCollection,
  schemaName: string,
  tableName: string,
  catalogName?: string,
): string {
  const resolved = resolveCatalog(collection, catalogName);
  if (typeof resolved === "string") return resolved;
  const schema = resolved.schemas.find((s) => s.info.name === schemaName);
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
      catalog: resolved.catalogName,
      schema: schemaName,
      name: tableName,
      qualified_name: `${resolved.catalogName}.${schemaName}.${tableName}`,
      type: "table",
      comment: detailText(table.comment),
      tags: filterTagsForAIDetail(table.tags),
      required_filters: table.required_filters?.length ? table.required_filters : null,
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
          comment: detailText(c.comment),
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
    catalog: resolved.catalogName,
    schema: schemaName,
    name: tableName,
    qualified_name: `${resolved.catalogName}.${schemaName}.${tableName}`,
    type: "view",
    comment: detailText(view!.comment),
    tags: filterTagsForAIDetail(view!.tags),
  });
}

function boundedExamples(examples: Array<{ sql: string; description?: string | null }>) {
  return examples.slice(0, 5).map((example) => ({
    description: example.description || null,
    sql: example.sql.length > 4_000 ? `${example.sql.slice(0, 4_000)}… [truncated]` : example.sql,
  }));
}

export function executeDescribeFunction(collection: CatalogCollection, input: any): string {
  const resolved = resolveCatalog(collection, input.catalog);
  if (typeof resolved === "string") return resolved;
  const schema = resolved.schemas.find((candidate) => candidate.info.name === input.schema);
  if (!schema) return JSON.stringify({ error: `Schema '${input.schema}' not found`, catalog: resolved.catalogName });
  const func = schema.functions.find((candidate) => candidate.name === input.function);
  if (func) {
    const returned = getFunctionReturn(func);
    return JSON.stringify({
      catalog: resolved.catalogName,
      schema: input.schema,
      name: input.function,
      qualified_name: `${resolved.catalogName}.${input.schema}.${input.function}`,
      type: func.function_type,
      signature: formatFunctionSignature(func),
      comment: detailText(func.comment),
      description: detailText(func.description),
      category: getTag(func.tags, TAG_CATEGORY) || null,
      categories: func.categories,
      stability: func.stability || null,
      arguments: getFunctionArgs(func).map((argument) => ({
        ...argument,
        description: detailText(argument.description) || undefined,
        defaultValue: detailText(argument.defaultValue) || undefined,
        range: detailText(argument.range) || undefined,
        pattern: detailText(argument.pattern) || undefined,
      })),
      returns: returned,
      examples: boundedExamples(func.examples || []),
      tags: filterTagsForAIDetail(func.tags),
    });
  }
  const macro = schema.macros.find((candidate) => candidate.name === input.function);
  if (macro) {
    return JSON.stringify({
      catalog: resolved.catalogName,
      schema: input.schema,
      name: input.function,
      qualified_name: `${resolved.catalogName}.${input.schema}.${input.function}`,
      type: macro.macro_type === "TABLE" ? "table_macro" : "scalar_macro",
      comment: detailText(macro.comment),
      parameters: macro.parameters,
      definition: detailText(macro.definition),
      category: getTag(macro.tags, TAG_CATEGORY) || null,
      tags: filterTagsForAIDetail(macro.tags),
    });
  }
  return JSON.stringify({ error: `Function or macro '${input.function}' not found in schema '${input.schema}'`, catalog: resolved.catalogName });
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

interface StreamResult {
  content: ContentBlock[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messageId?: string;
  diagnostics?: unknown;
}

type ResolvedTelemetryMode = "off" | "usage" | "full";
const cacheDiagnosticMessageIds = new WeakMap<MessageParam[], string>();

function cacheDiagnosticsEnabled(): boolean {
  return typeof window !== "undefined" && (window as any).__cupolaAiCacheDiagnostics === true;
}

function systemPromptText(systemPrompt: SystemPrompt): string {
  return typeof systemPrompt === "string"
    ? systemPrompt
    : systemPrompt.map((block) => block.text).join("\n\n");
}

function systemPromptBlocks(systemPrompt: SystemPrompt): Array<Record<string, unknown>> {
  if (typeof systemPrompt === "string") {
    return [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  }
  return systemPrompt.map((block) => ({
    type: "text",
    text: block.text,
    ...(block.cacheControl ? { cache_control: { type: "ephemeral" } } : {}),
  }));
}

/** One streamed Messages-API request, wrapped in a gen_ai.chat span when
 *  telemetry is on. The span covers fetch (including ai-fetch retries) through
 *  SSE stream end; request content goes on at start, usage/output at end. */
async function streamOneRequest(
  credentials: AnthropicCredentials,
  model: string,
  messages: MessageParam[],
  systemPrompt: SystemPrompt,
  callbacks: AgentCallbacks,
  tools: Tool[],
  maxTokens: number,
  signal: AbortSignal | undefined,
  telemetryMode: ResolvedTelemetryMode,
  diagnosticPreviousMessageId?: string | null,
): Promise<StreamResult> {
  if (telemetryMode === "off") {
    return streamOneRequestInner(credentials, model, messages, systemPrompt, callbacks, tools, maxTokens, signal, diagnosticPreviousMessageId);
  }
  return Sentry.startSpan(
    {
      name: `chat ${model}`,
      op: "gen_ai.chat",
      attributes: {
        [ATTR.OPERATION_NAME]: "chat",
        [ATTR.REQUEST_MODEL]: model,
        [ATTR.SYSTEM]: "anthropic",
        ...(telemetryMode === "full" ? {
          [ATTR.INPUT_MESSAGES]: serializeInputMessages(messages),
          [ATTR.SYSTEM_INSTRUCTIONS]: systemPromptText(systemPrompt),
          [ATTR.AVAILABLE_TOOLS]: serializeToolDefinitions(tools),
        } : {}),
      },
    },
    async (span) => {
      try {
        const result = await streamOneRequestInner(
          credentials, model, messages, systemPrompt, callbacks, tools, maxTokens, signal, diagnosticPreviousMessageId
        );
        span.setAttributes({
          ...mapUsageAttributes(result),
          [ATTR.FINISH_REASONS]: [result.stopReason],
          ...(telemetryMode === "full" ? {
            [ATTR.OUTPUT_MESSAGES]: serializeOutputMessages(result.content, result.stopReason),
          } : {}),
        });
        return result;
      } catch (err) {
        if (isAbortError(err)) span.setStatus({ code: 2, message: "cancelled" });
        throw err;
      }
    }
  );
}

async function streamOneRequestInner(
  credentials: AnthropicCredentials,
  model: string,
  messages: MessageParam[],
  systemPrompt: SystemPrompt,
  callbacks: AgentCallbacks,
  tools: Tool[],
  maxTokens: number,
  signal?: AbortSignal,
  diagnosticPreviousMessageId?: string | null,
): Promise<StreamResult> {
  const workspaceId = credentials.workspaceId?.trim();
  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": credentials.apiKey,
        ...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": diagnosticPreviousMessageId !== undefined
          ? "prompt-caching-2024-07-31,cache-diagnosis-2026-04-07"
          : "prompt-caching-2024-07-31",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        // Advance a cache breakpoint with the growing conversation so prior
        // assistant/tool turns are cache reads instead of uncached input.
        // Explicit tool/system markers below retain independently reusable
        // prefixes when later context changes.
        cache_control: { type: "ephemeral" },
        ...(diagnosticPreviousMessageId !== undefined
          ? { diagnostics: { previous_message_id: diagnosticPreviousMessageId } }
          : {}),
        // Place cache_control on the LAST tool of whatever active set the
        // caller passed. Hardcoding the index would fragment the cache
        // across surfaces that ship different tool subsets (e.g. terminal
        // vs AskAIChat with the chart tool).
        ...(tools.length
          ? {
              tools: tools.map((t, i) =>
                i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
              ),
            }
          : {}),
        system: systemPromptBlocks(systemPrompt),
        // Clamped per model: over the model's ceiling is a 400. Streaming is
        // on, so the usual non-streaming timeout argument for a small cap
        // doesn't apply — the old hardcoded 4096 truncated long tool_use
        // blocks (large Vega specs) mid-JSON.
        max_tokens: clampMaxTokens(model, maxTokens),
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
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let messageId: string | undefined;
  let diagnostics: unknown;

  for await (const event of parseSSEStream(reader, signal)) {
    if (event.type === "message_start" && event.message?.usage) {
      // input_tokens is the UNCACHED remainder; the cache counts are disjoint.
      const usage = event.message.usage;
      messageId = event.message.id;
      diagnostics = event.message.diagnostics;
      inputTokens = usage.input_tokens || 0;
      cacheReadTokens = usage.cache_read_input_tokens || 0;
      cacheWriteTokens = usage.cache_creation_input_tokens || 0;
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
        callbacks.onToolInputStart?.(event.content_block.name);
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
          // Empty input (no-arg tools like list_tables stream "") → {}. A
          // non-empty payload that won't parse yields the __parseError
          // sentinel so the dispatch loop returns a self-correctable error
          // (a silent {} would run a tool with undefined arguments).
          currentBlock.input = parseStreamedToolInput(currentToolInput).input;
        }
        content.push(currentBlock);
        currentBlock = null;
      }
    } else if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason || stopReason;
      if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
    }
  }

  return { content, stopReason, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, messageId, diagnostics };
}

// History self-heal lives in ./ai-history (pure, no service/VGI imports) so it
// stays unit-testable without dragging in the RPC graph. Re-exported so the
// existing `from "./ai-agent"` import surface keeps working.
export { sanitizeConversation, sanitizeDanglingToolUse, mergeAdjacentSameRole } from "./ai-history";
import { sanitizeConversation } from "./ai-history";

// ---------------------------------------------------------------------------
// Public API — run a full agent turn (may loop for tool calls)
// ---------------------------------------------------------------------------

export interface AnthropicCredentials {
  apiKey: string;
  /** Required for personal/service-account keys that can access more than one workspace. */
  workspaceId?: string;
}

export async function runAgentTurn(
  credentials: AnthropicCredentials,
  model: string,
  messages: MessageParam[],
  systemPrompt: SystemPrompt,
  executeTool: (name: string, input: any, signal?: AbortSignal) => Promise<ToolResult>,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  maxToolRounds = 20,
  tools: Tool[] = TOOLS,
  maxTokens: number = DEFAULT_AI_MAX_TOKENS,
  telemetry: AgentTelemetryMode = true,
): Promise<void> {
  const telemetryMode: ResolvedTelemetryMode = telemetry === "usage"
    ? "usage"
    : telemetry && isAiTelemetryEnabled()
      ? "full"
      : "off";
  if (telemetryMode === "off") {
    return runAgentTurnInner(
      credentials, model, messages, systemPrompt, executeTool, callbacks, signal, maxToolRounds, tools, maxTokens, null, telemetryMode
    );
  }
  // startNewTrace detaches the turn from any active pageload/navigation trace,
  // making invoke_agent a root span — so the tracesSampler (which keeps AI
  // traces at 100%) decides its fate instead of the page's sampling decision.
  return Sentry.startNewTrace(() =>
    Sentry.startSpan(
      {
        name: `invoke_agent ${AGENT_NAME}`,
        op: "gen_ai.invoke_agent",
        attributes: {
          // The op isn't visible to tracesSampler at sampling time; mirror it
          // as an attribute the sampler can match on.
          "sentry.op": "gen_ai.invoke_agent",
          [ATTR.OPERATION_NAME]: "invoke_agent",
          [ATTR.AGENT_NAME]: AGENT_NAME,
          [ATTR.REQUEST_MODEL]: model,
          [ATTR.SYSTEM]: "anthropic",
        },
      },
      async (span) => {
        try {
          await runAgentTurnInner(
            credentials, model, messages, systemPrompt, executeTool, callbacks, signal, maxToolRounds, tools, maxTokens, span, telemetryMode
          );
        } catch (err) {
          // User cancellations are not internal errors; this status sticks
          // because startSpan only overwrites an unset/ok status on throw.
          if (isAbortError(err)) span.setStatus({ code: 2, message: "cancelled" });
          throw err;
        }
      }
    )
  );
}

async function runAgentTurnInner(
  credentials: AnthropicCredentials,
  model: string,
  messages: MessageParam[],
  systemPrompt: SystemPrompt,
  executeTool: (name: string, input: any, signal?: AbortSignal) => Promise<ToolResult>,
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
  maxToolRounds: number,
  tools: Tool[],
  maxTokens: number,
  agentSpan: AgentSpan | null,
  telemetryMode: ResolvedTelemetryMode,
): Promise<void> {
  const MAX_TOOL_ROUNDS = maxToolRounds;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let rounds = 0;
  const diagnosticsEnabled = cacheDiagnosticsEnabled();
  let diagnosticPreviousMessageId: string | null | undefined = diagnosticsEnabled
    ? cacheDiagnosticMessageIds.get(messages) ?? null
    : undefined;
  // Roll the turn's accumulated usage onto the invoke_agent span before each
  // onDone exit path.
  const recordTurnUsage = () => {
    agentSpan?.setAttributes(
      mapUsageAttributes({
        inputTokens: totalInputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens,
        outputTokens: totalOutputTokens,
      })
    );
  };
  // Per-turn counter for the repeated-call loop-breaker (see ai-loop-guard).
  const toolCallCounts = new Map<string, number>();

  // Heal any conversation left in an API-invalid shape by an interrupted turn
  // (e.g. a dangling tool_use, or a trailing user/tool_result message now sat
  // next to the freshly-appended user question) before we send it — otherwise
  // the API 400s on every request and the chat is permanently stuck.
  sanitizeConversation(messages);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Cancellation between rounds: throw (not bare return) so the UI runs its
    // "stopped" handling and clears the streaming spinner. The trailing
    // tool_result message is left valid; the next turn's sanitizeConversation
    // folds the next user question into it to preserve role alternation.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // Shed chart PNGs from earlier in the conversation — only the most recent
    // render needs to ride along for the model to evaluate (see helper doc).
    pruneCarriedToolImages(messages);

    // Single retry policy: fetchWithRetry handles 429/529 (retry-after), network
    // errors (exponential backoff with jitter), and abort-signal short-circuiting.
    // Any error that escapes here is final — do not re-retry, which would
    // multiply attempts and resend the full conversation each time.
    const request = await streamOneRequest(
      credentials, model, messages, systemPrompt, callbacks, tools, maxTokens, signal, telemetryMode,
      diagnosticPreviousMessageId,
    );
    const { content, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = request;
    rounds++;
    if (diagnosticsEnabled) {
      if (request.messageId) {
        cacheDiagnosticMessageIds.set(messages, request.messageId);
        diagnosticPreviousMessageId = request.messageId;
      }
      const diagnostic: AgentCacheDiagnostics = {
        messageId: request.messageId,
        uncachedInputTokens: inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        diagnostics: request.diagnostics,
      };
      callbacks.onCacheDiagnostics?.(diagnostic);
      if (aiDebugEnabled()) console.info("[ai] cache diagnostics", diagnostic);
    }
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCacheReadTokens += cacheReadTokens;
    totalCacheWriteTokens += cacheWriteTokens;

    // Add assistant response to history
    messages.push({ role: "assistant", content });

    // Gate on the PRESENCE of tool_use blocks, NOT on stopReason. A response
    // can stop with stopReason "max_tokens" (we cap max_tokens at 4096) or
    // "pause_turn" while still carrying a complete tool_use block. If we keyed
    // off stopReason === "tool_use" and skipped execution, that tool_use would
    // be left without a tool_result and EVERY later request would 400 with
    // "tool_use ids were found without tool_result blocks". So whenever the
    // model emitted a tool_use, we must respond with a tool_result for it.
    const toolUseBlocks = content.filter(
      (b): b is ContentBlock & { id: string; name: string } =>
        b.type === "tool_use" && !!b.id && !!b.name
    );

    if (toolUseBlocks.length === 0) {
      recordTurnUsage();
      callbacks.onDone({
        inputTokens: totalInputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens,
        outputTokens: totalOutputTokens,
        rounds,
      });
      return;
    }

    // Collapse the assistant message we just pushed to its text blocks only,
    // dropping the tool_use blocks. Called when we bail out of a round (user
    // cancel, or a fatal connection error) before producing a tool_result for
    // every tool_use. An assistant message carrying an UNMATCHED tool_use
    // poisons the whole conversation permanently — the API rejects every
    // subsequent request — so we strip the tool_use rather than leave it
    // dangling. Keeping it an assistant message (never an empty/omitted one)
    // also preserves user/assistant alternation for the next turn.
    const dropToolUseFromLastAssistant = () => {
      const last = messages[messages.length - 1];
      const textOnly = (last.content as ContentBlock[]).filter(
        (b) => b.type === "text" && b.text
      );
      last.content = textOnly.length ? textOnly : [{ type: "text", text: "(stopped)" }];
    };

    // User cancelled before any tool ran this round.
    if (signal?.aborted) {
      dropToolUseFromLastAssistant();
      throw new DOMException("Aborted", "AbortError");
    }

    // Execute tool calls. Check signal between tools so a user-initiated
    // cancel takes effect promptly even if some tool finished naturally.
    const toolResults: ToolResultBlock[] = [];
    let fatalMsg: string | null = null;
    for (const block of toolUseBlocks) {
      // Cancellation between tools: strip the tool_use so history stays valid,
      // then rethrow so the UI runs its "stopped" handling.
      if (signal?.aborted) {
        dropToolUseFromLastAssistant();
        throw new DOMException("Aborted", "AbortError");
      }
      callbacks.onToolCall(block.name, block.input);
      if (block.input && typeof block.input === "object" && "__parseError" in block.input) {
        const raw = String(block.input.__parseError ?? "");
        const errMsg = `Tool input was not valid JSON. Raw partial input: ${raw.slice(0, 500)}`;
        callbacks.onToolResult(block.name, `Error: ${errMsg}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: errMsg,
          is_error: true,
        });
        continue;
      }
      // Loop-breaker: refuse a deterministic metadata tool (list_tables,
      // describe_table, read_query_results) once it's been called with
      // identical args too many times. Stops the agent from spinning on
      // "Looking up tables…" until it exhausts MAX_TOOL_ROUNDS.
      const guard = recordToolCall(toolCallCounts, block.name, block.input);
      if (guard.block) {
        const msg = repeatedCallMessage(block.name, guard.count);
        logToolError(block.name, msg);
        callbacks.onToolResult(block.name, `Error: ${msg}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: msg,
          is_error: true,
        });
        continue;
      }
      // Dev-side console trace: shows tool name + input before the
      // call, plus the result (or error) after. Enables debugging the
      // agent's behavior from the browser console. Gated by a window
      // flag so we can leave it on by default without polluting end-
      // user consoles — set window.__cupolaAiDebug = false to silence.
      logToolCall(block.name, block.input);
      // gen_ai.execute_tool span around the real tool execution only — the
      // parse-error and loop-guard short-circuits above never reach the tool.
      const runTool = (): Promise<ToolResult> => {
        if (agentSpan === null) return executeTool(block.name, block.input, signal);
        return Sentry.startSpan(
          {
            name: `execute_tool ${block.name}`,
            op: "gen_ai.execute_tool",
            attributes: {
              [ATTR.OPERATION_NAME]: "execute_tool",
              [ATTR.TOOL_NAME]: block.name,
              [ATTR.TOOL_TYPE]: "function",
              [ATTR.TOOL_CALL_ID]: block.id,
              [ATTR.AGENT_NAME]: AGENT_NAME,
              ...(telemetryMode === "full" ? { [ATTR.TOOL_INPUT]: JSON.stringify(block.input) } : {}),
            },
          },
          async (toolSpan) => {
            try {
              const r = await executeTool(block.name, block.input, signal);
              if (telemetryMode === "full") toolSpan.setAttribute(ATTR.TOOL_OUTPUT, serializeToolResult(r));
              return r;
            } catch (err) {
              if (isAbortError(err)) toolSpan.setStatus({ code: 2, message: "cancelled" });
              throw err;
            }
          }
        );
      };
      try {
        const result = await runTool();
        if (signal?.aborted) {
          dropToolUseFromLastAssistant();
          throw new DOMException("Aborted", "AbortError");
        }
        // Build a short display string for the UI (the array form carries
        // an image; we summarize using its text parts only). The full
        // result still goes to the model via toolResults below.
        const summary = typeof result === "string"
          ? result
          : result.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join(" ");
        logToolResult(block.name, result);
        callbacks.onToolResult(block.name, summary.length > 200 ? summary.slice(0, 200) + "…" : summary);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      } catch (err: any) {
        // Cancellation surfaced as a rejected tool promise (withAbort): strip
        // the tool_use and rethrow so the conversation isn't left dangling.
        if (err?.name === "AbortError") {
          dropToolUseFromLastAssistant();
          throw err;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        logToolError(block.name, errMsg);
        callbacks.onToolResult(block.name, `Error: ${errMsg}`);

        // Fatal errors (e.g., VGI server crash) — abandon the rest of the
        // round. Recorded here and handled after the loop so we never push a
        // partial tool_result set (which would leave the remaining tool_use
        // blocks unmatched).
        if ((err as any).fatal) {
          fatalMsg = errMsg;
          break;
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: errMsg,
          is_error: true,
        });
      }
    }

    // Fatal connection error mid-round: the model can't continue and we don't
    // have a result for every tool_use, so strip the tool_use to keep history
    // valid and stop the agent.
    if (fatalMsg !== null) {
      dropToolUseFromLastAssistant();
      recordTurnUsage();
      callbacks.onError(`Connection error — agent stopped. ${fatalMsg}`);
      callbacks.onDone({
        inputTokens: totalInputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens,
        outputTokens: totalOutputTokens,
        rounds,
      });
      return;
    }

    messages.push({ role: "user", content: toolResults });
  }

  recordTurnUsage();
  callbacks.onError("Too many tool rounds. Try a simpler question.");
  callbacks.onDone({
    inputTokens: totalInputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheWriteTokens: totalCacheWriteTokens,
    outputTokens: totalOutputTokens,
    rounds,
  });
}

export { type MessageParam, type ContentBlock, type ToolResultBlock, type Tool };
// ToolResult and ToolResultContent are already `export type` declarations above.
