/**
 * AI Agent — Claude-powered data analyst for the DuckDB shell.
 * Uses raw fetch + SSE parsing (no SDK dependency).
 * Provides tools: run_sql, read_query_results, list_tables, describe_table,
 * ask_user.
 */

import type { CatalogData } from "./service";
import { getColumns, getForeignKeys } from "./service";
import { filterTagsForAI, TAG_DESCRIPTION_LLM, TAG_DESCRIPTION_MD, TAG_EXAMPLE_QUERIES } from "./tags";
import { fetchWithRetry } from "./ai-fetch";

// Keep in sync with the extension list loaded in src/lib/shell-init.ts.
// Spatial is loaded there, so the spatial-aware prompting below is active.
const SPATIAL_ENABLED = true;

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

export interface AgentCallbacks {
  onText: (chunk: string) => void;
  onToolCall: (name: string, input: any) => void;
  onToolResult: (name: string, summary: string) => void;
  onDone: (usage?: { inputTokens: number; outputTokens: number }) => void;
  onError: (error: string) => void;
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
// System prompt builder
// ---------------------------------------------------------------------------

export function buildSystemPrompt(catalog: CatalogData, serviceUrl: string, memoryCatalog?: CatalogData | null, hasChartTool: boolean = false): string {
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
    ...(hasChartTool ? [`* **render_chart** — Visualize SQL results as a Vega-Lite chart in the chat. **Call this tool ONLY when the user explicitly asks for a visualization** — words like "chart", "plot", "graph", "histogram", "scatter", "map", "heatmap", "bar/line chart", "visualize", "show me a [chart]". For every other question (counts, lookups, comparisons, top-N lists, summaries) return a table or prose. Do not volunteer a chart because the data happens to be plottable or because "it might be helpful". Visualizations are user-initiated, not agent-initiated. When the user IS asking for a chart: provide a re-runnable SELECT and a minimal Vega-Lite v5 spec WITHOUT \`data\` or \`datasets\` fields — rows are injected automatically. For multi-series charts, either (a) write one SELECT with a category column and encode it via \`color\`/\`strokeDash\`, or (b) pass additional sources via the \`extraData\` parameter and reference them in layer marks as \`data: { name: '...' }\` when sources have different shapes (e.g. earthquakes + volcanos). Do NOT inline data values.`] : []),
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
    ...(hasChartTool ? [
      `### Chart iteration`,
      `**Charts always render on a WHITE background.** Color choices must work against white — no white text, no pale yellows or light grays, no near-white pastels. For any text mark labeling data points (e.g. \`mark: "text"\` with values from a column), prefer DARK text colors like \`"#1a1a1a"\` / \`"black"\` / a dark slate. Default Vega-Lite text rendering on a white background is fine — only override color when you need to emphasize.`,
      `Every render_chart tool_result includes a PNG of that rendered chart. **Evaluate it as a data-visualization expert would.** Before moving on, check:`,
      `* Is every element clearly visible against the white background? Pale fills, light strokes, and white-on-white never pass.`,
      `* Data-point labels and annotations use dark text? If a \`mark: "text"\` label is too light to read, set \`color: "#1a1a1a"\` (or another dark value) explicitly.`,
      `* Are axis labels, tick labels, legend entries, and the title all legible at this size? No overlap, no truncation, no clipping at the edges.`,
      `* Are colors distinct enough to tell categories apart? For a FEW nominal categories (≤~10) use \`scheme: "tableau10"\`; up to ~20 use \`"tableau20"\`. Categorical schemes have only 10–20 colors and silently REPEAT beyond that — so for HIGH-CARDINALITY color (e.g. one distinct color per feature across 50+ categories) you must use a cyclical/continuous scheme like \`scheme: "sinebow"\`, \`"rainbow"\`, or \`"turbo"\` instead, and set \`"legend": null\` (a 50+ entry legend overflows the plot and is useless). If the categories have no inherent meaning, consider whether a quantitative attribute would be a better color encoding than one-color-per-item.`,
      `* Is the scale appropriate (log only for strictly positive data; quantitative axes start at zero unless that defeats the comparison)?`,
      `* Would a viewer who hadn't read the user's question understand what the chart shows at a glance?`,
      `If ANY of those checks fail, immediately call render_chart again with a fixed spec. Common fixes: rotate axis labels with \`labelAngle: -45\`, use \`point\` instead of \`circle\` when you need shape encoding, sort the x-axis, add explicit axis titles, set a dark mark/text color for low-contrast elements, increase \`size\`. **Iterate until the chart meets all checks — the user sees only the version you settle on, so don't ship a draft.** When you're satisfied, give the user a short interpretation of what the chart shows.`,
      `**Faceted / repeated / concat charts** (specs with top-level \`facet\`, \`repeat\`, \`concat\`/\`hconcat\`/\`vconcat\`, or \`encoding.row\` / \`encoding.column\`): Vega-Lite ignores top-level \`width\`/\`height\` on these — the chat surface will NOT inject sizing. You MUST set dimensions per-unit-spec yourself: e.g. \`{ facet: { row: { field: "..." } }, spec: { width: 300, height: 150, mark: "circle", encoding: {...} } }\`, or for repeat: \`{ repeat: [...], spec: { width: 200, height: 120, ... } }\`. Keep per-facet width modest (150-300) so the row of facets fits horizontally.`,
      ``,
      ...(SPATIAL_ENABLED ? [
        `### Plotting geometry (maps)`,
        `Geometry columns hold spatial data (WGS84 / EPSG:4326 — longitude/latitude in degrees). There are two ways to map them, and a \`projection\` is ALWAYS required (use \`{"type": "mercator"}\` for general/world data, \`{"type": "albersUsa"}\` for US-only data).`,
        ``,
        `**Points** — pull the coordinates out in SQL and use Vega-Lite's \`longitude\`/\`latitude\` encoding channels (NOT \`x\`/\`y\`):`,
        `\`\`\`sql`,
        `SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, name FROM ${exFull};`,
        `\`\`\``,
        `\`\`\`json`,
        `{ "projection": {"type": "mercator"}, "mark": "circle",`,
        `  "encoding": { "longitude": {"field": "lon", "type": "quantitative"},`,
        `                "latitude":  {"field": "lat", "type": "quantitative"},`,
        `                "color": {"field": "name", "type": "nominal"} } }`,
        `\`\`\``,
        ``,
        `**Polygons / lines / mixed geometry** — \`SELECT\` the geometry column directly (do NOT wrap it in \`ST_AsGeoJSON\`; do NOT select raw WKB text). The chat surface prepares the geometry for the map renderer FOR YOU: it reshapes the rows into GeoJSON **Feature** objects (your geometry column becomes each feature's geometry, and EVERY OTHER selected column becomes a \`properties\` entry) and orients the polygon rings correctly. Do NOT try to convert, reproject, or re-wind the geometry yourself (no \`ST_ForcePolygonCCW\`, no coordinate reversing) — if a map looks wrong, the cause is the spec, not the geometry. Therefore:`,
        `* Use a bare \`"mark": "geoshape"\` — do NOT add a \`shape\` encoding (a \`shape: {type: "geojson"}\` channel renders NOTHING).`,
        `* Reference every non-geometry column with a \`properties.\` prefix in encodings (e.g. \`"field": "properties.population"\`, NOT \`"population"\`).`,
        `* A \`projection\` is required.`,
        `\`\`\`sql`,
        `SELECT geom, region_name, population FROM ${exFull};`,
        `\`\`\``,
        `\`\`\`json`,
        `{ "projection": {"type": "mercator"}, "mark": "geoshape",`,
        `  "encoding": { "color":   {"field": "properties.population", "type": "quantitative"},`,
        `                "tooltip": {"field": "properties.region_name", "type": "nominal"} } }`,
        `\`\`\``,
        ``,
        `**Giving every feature its own color** (e.g. "each county a different color"): this is high-cardinality nominal color — a default/categorical scheme only has 10–20 colors and will repeat. Use a cyclical scheme and hide the legend: \`"color": {"field": "properties.name", "type": "nominal", "scale": {"scheme": "sinebow"}, "legend": null}\`.`,
        `**Performance:** detailed geometries are expensive to render and can overflow. Filter to only the rows you need, and simplify large/dense shapes in SQL first — e.g. \`ST_Simplify(geom, 0.001) AS geom\` (tolerance in degrees; a US-county-sized polygon shrinks from ~200KB to ~2KB at 0.01). To overlay points on a boundary, use a layered spec: the polygon \`geoshape\` as one layer and the \`circle\` (longitude/latitude) as another, sharing one top-level \`projection\`.`,
        ``,
      ] : []),
    ] : []),
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
    `Loaded extensions: icu, json, httpfs, iceberg, spatial, ducklake`,
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
    lines.push(`Geometry columns are lon/lat degrees in WGS84 (EPSG:4326 / OGC:CRS84). The data is global — coordinates can be anywhere on Earth, so never hardcode a region-specific projection.`);
    lines.push(``);
    lines.push(`The plain \`ST_Distance\` / \`ST_Area\` / \`ST_Length\` return values in DEGREES, which are meaningless for real-world measurement. Use these instead:`);
    lines.push(``);
    lines.push(`**Area / length / perimeter — accept GEOMETRY directly, return m² / m on the WGS84 spheroid. No projection needed:**`);
    lines.push(`* \`ST_Area_Spheroid(geom)\` → square metres`);
    lines.push(`* \`ST_Length_Spheroid(geom)\` / \`ST_Perimeter_Spheroid(geom)\` → metres`);
    lines.push(``);
    lines.push(`**Distance is the exception.** \`ST_Distance_Spheroid\` and \`ST_Distance_Sphere\` only work on POINT geometries — calling them on a polygon/line raises a binder or runtime error. For distance or proximity between ARBITRARY geometries, reproject BOTH to a local metre-based CRS, then use the plain planar functions (which give true edge-to-edge metres). For worldwide data, derive the CRS from the data's own longitude so it works anywhere — the UTM zone covering it:`);
    lines.push(`\`\`\`sql`);
    lines.push(`-- Pick ONE UTM zone for the area of interest (32600+zone north, 32700+zone south):`);
    lines.push(`WITH p AS (SELECT 'EPSG:' || (32600 + (floor((ST_X(ST_Centroid(geom)) + 180) / 6)::INT + 1)) AS crs`);
    lines.push(`           FROM ${exFull} LIMIT 1)`);
    lines.push(`SELECT ... FROM ${exFull} a, ${exFull} b, p`);
    lines.push(`-- proximity ("within 50 km"): ST_DWithin short-circuits — prefer it over ST_Distance(...) <= x`);
    lines.push(`WHERE ST_DWithin(ST_Transform(a.geom, 'EPSG:4326', p.crs, always_xy := true),`);
    lines.push(`                 ST_Transform(b.geom, 'EPSG:4326', p.crs, always_xy := true), 50000);`);
    lines.push(`\`\`\``);
    lines.push(`Non-negotiable details:`);
    lines.push(`* **Pass \`always_xy := true\`** (4th arg to ST_Transform) — the data is lon/lat, but ST_Transform otherwise assumes lat/lon and silently swaps the axes, giving wrong (often zero) distances.`);
    lines.push(`* **Both geometries must use the SAME target CRS** — transform both with the one \`p.crs\`, never per-row. UTM is accurate for the local/proximity distances these queries ask for; for a continent-wide span use an equal-distance CRS for that region instead.`);
    lines.push(`* For point-to-point geodesic distance specifically, \`ST_Distance_Spheroid(p1, p2)\` works directly on POINT_2D values (run \`SET geometry_always_xy = true\` first so lon/lat points aren't swapped).`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

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

async function streamOneRequest(
  apiKey: string,
  model: string,
  messages: MessageParam[],
  systemPrompt: string,
  callbacks: AgentCallbacks,
  tools: Tool[],
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
        // Place cache_control on the LAST tool of whatever active set the
        // caller passed. Hardcoding the index would fragment the cache
        // across surfaces that ship different tool subsets (e.g. terminal
        // vs AskAIChat with the chart tool).
        tools: tools.map((t, i) =>
          i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
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

  return { content, stopReason, inputTokens, outputTokens };
}

// History self-heal lives in ./ai-history (pure, no service/VGI imports) so it
// stays unit-testable without dragging in the RPC graph. Re-exported so the
// existing `from "./ai-agent"` import surface keeps working.
export { sanitizeConversation, sanitizeDanglingToolUse, mergeAdjacentSameRole } from "./ai-history";
import { sanitizeConversation } from "./ai-history";

// ---------------------------------------------------------------------------
// Public API — run a full agent turn (may loop for tool calls)
// ---------------------------------------------------------------------------

export async function runAgentTurn(
  apiKey: string,
  model: string,
  messages: MessageParam[],
  systemPrompt: string,
  executeTool: (name: string, input: any, signal?: AbortSignal) => Promise<ToolResult>,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  maxToolRounds = 20,
  tools: Tool[] = TOOLS,
): Promise<void> {
  const MAX_TOOL_ROUNDS = maxToolRounds;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
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
    const { content, inputTokens, outputTokens } = await streamOneRequest(
      apiKey, model, messages, systemPrompt, callbacks, tools, signal
    );
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

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
      callbacks.onDone({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
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
      try {
        const result = await executeTool(block.name, block.input, signal);
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
      callbacks.onError(`Connection error — agent stopped. ${fatalMsg}`);
      callbacks.onDone({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
      return;
    }

    messages.push({ role: "user", content: toolResults });
  }

  callbacks.onError("Too many tool rounds. Try a simpler question.");
  callbacks.onDone();
}

export { type MessageParam, type ContentBlock, type ToolResultBlock, type Tool };
// ToolResult and ToolResultContent are already `export type` declarations above.
