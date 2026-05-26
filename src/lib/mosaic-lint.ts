/* ── Mosaic spec semantic linter ──
 *
 * The JSON-schema validator catches structural problems (wrong attribute
 * names, missing required keys, type mismatches). This module catches
 * SEMANTIC problems the schema can't see — interactor/scale compatibility,
 * primarily. The motivating bug:
 *
 *     "plot": [
 *       { "mark": "barY", "x": "category", "y": "n" },
 *       { "select": "intervalX", "as": "$brush" }  // CRASH ON BRUSH-DRAG
 *     ]
 *
 * `intervalX` is a continuous-axis brush — it calls `scale.invert(pixel)`
 * to convert drag coordinates to data. `barY` makes X categorical (a band
 * scale, no `.invert`), so dragging the brush throws
 * `TypeError: scale.invert is not a function`. The error fires at INTERACTION
 * time, not at render — our pre-render error capture in `renderChartSpec`
 * doesn't see it. Without this lint, the agent ships a spec that renders
 * fine but crashes the moment a user drags.
 *
 * Mosaic interactors that call `scale.invert`:
 *   - intervalX, intervalY, intervalXY (per Interval1D.js / Interval2D.js)
 *   - panZoom (per PanZoom.js)
 * Mosaic interactors that do NOT call invert (work on any scale):
 *   - toggle, toggleX, toggleY  ← the right choice for categorical axes
 *   - nearestX, nearestY        ← point lookups, work on any scale
 *   - highlight
 *
 * We can't reliably infer axis types for free-form marks like `dot` or
 * `circle` (they accept any column type), so this lint covers the marks
 * whose axis types are FIXED by their mark name:
 *   - barY  → X categorical, Y continuous
 *   - barX  → Y categorical, X continuous
 *   - cell  → BOTH categorical
 *   - cellX → X categorical
 *   - cellY → Y categorical
 *
 * For `dot`/`circle`/`line`/`area`/etc., axis types depend on column
 * types; we'd need a DESCRIBE roundtrip to know. Skipped for the MVP —
 * the bar/cell rules already catch the most common AI mistake (visible in
 * the production trace that motivated this).
 */

export type LintSeverity = "error" | "warning";

export interface MosaicLintIssue {
  /** JSON pointer to the offending plot-array entry, e.g. `/plot/1`. */
  path: string;
  severity: LintSeverity;
  /** Human-readable diagnosis plus the recommended fix. */
  message: string;
  /** Which interactor `select` value triggered the issue, for downstream
   *  formatting. */
  selector: string;
}

type AxisHint = "continuous" | "categorical";

/** Map of mark name → forced axis types. Only marks whose names PIN an
 *  axis type appear here. Other marks (`dot`, `line`, `area`, …) get no
 *  entry — they can be continuous or categorical based on data. */
const MARK_AXIS_TYPES: Record<string, { x?: AxisHint; y?: AxisHint }> = {
  barY:   { x: "categorical", y: "continuous" },
  barX:   { y: "categorical", x: "continuous" },
  cell:   { x: "categorical", y: "categorical" },
  cellX:  { x: "categorical" },
  cellY:  { y: "categorical" },
};

/** Interactor `select` values that call `scale.invert` and therefore
 *  require continuous scales on the named axis (or both). */
const INVERTING_INTERACTORS: Record<string, { x: boolean; y: boolean }> = {
  intervalX:  { x: true,  y: false },
  intervalY:  { x: false, y: true  },
  intervalXY: { x: true,  y: true  },
  interval:   { x: true,  y: true  },  // alias used in some schema versions
  panZoom:    { x: true,  y: true  },
  panZoomX:   { x: true,  y: false },
  panZoomY:   { x: false, y: true  },
};

/**
 * Lint a Mosaic spec for interactor/scale compatibility issues. Returns
 * an empty array on success. Each issue is keyed by JSON pointer so the
 * agent can locate and fix the offending entry directly.
 */
export function lintMosaicSpec(spec: unknown): MosaicLintIssue[] {
  const issues: MosaicLintIssue[] = [];
  walkPlotContainers(spec, "", (path, plotArray) => {
    lintPlot(path, plotArray, issues);
  });
  return issues;
}

/**
 * Walk the spec recursively, invoking `fn` whenever we hit a node that has
 * a `plot` array (the unit of interactor co-location in Mosaic). Composite
 * layouts (`vconcat`, `hconcat`, `gridConcat`) recurse into their children.
 */
function walkPlotContainers(
  node: unknown,
  path: string,
  fn: (path: string, plotArray: any[]) => void,
): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.plot)) fn(`${path}/plot`, obj.plot);
  if (Array.isArray(obj.vconcat)) {
    obj.vconcat.forEach((c, i) => walkPlotContainers(c, `${path}/vconcat/${i}`, fn));
  }
  if (Array.isArray(obj.hconcat)) {
    obj.hconcat.forEach((c, i) => walkPlotContainers(c, `${path}/hconcat/${i}`, fn));
  }
  // gridConcat shape per Mosaic spec: { gridConcat: { columns: N, plots: [...] } }
  if (obj.gridConcat && typeof obj.gridConcat === "object") {
    const gc = obj.gridConcat as Record<string, unknown>;
    if (Array.isArray(gc.plots)) {
      gc.plots.forEach((c, i) => walkPlotContainers(c, `${path}/gridConcat/plots/${i}`, fn));
    }
  }
}

/** Lint a single `plot` array: classify entries, merge axis hints from
 *  ALL marks present, then check every inverting interactor against the
 *  merged hints. */
function lintPlot(plotPath: string, plotArray: any[], out: MosaicLintIssue[]): void {
  const marks: { idx: number; mark: string }[] = [];
  const interactors: { idx: number; select: string }[] = [];
  for (let i = 0; i < plotArray.length; i++) {
    const e = plotArray[i];
    if (!e || typeof e !== "object") continue;
    if (typeof e.mark === "string") marks.push({ idx: i, mark: e.mark });
    if (typeof e.select === "string") interactors.push({ idx: i, select: e.select });
  }
  if (interactors.length === 0) return;

  // Merge axis hints across marks. If ANY mark in the plot forces an axis
  // to categorical, that axis IS categorical for interactor purposes (a
  // single mark dictates the scale type for the plot).
  const hints: { x?: AxisHint; y?: AxisHint } = {};
  const forcingMarks: { x?: string; y?: string } = {};
  for (const { mark } of marks) {
    const m = MARK_AXIS_TYPES[mark];
    if (!m) continue;
    if (m.x === "categorical") { hints.x = "categorical"; forcingMarks.x ??= mark; }
    if (m.y === "categorical") { hints.y = "categorical"; forcingMarks.y ??= mark; }
    // Don't downgrade an already-set categorical to continuous; the
    // categorical mark wins.
    if (m.x === "continuous" && hints.x === undefined) hints.x = "continuous";
    if (m.y === "continuous" && hints.y === undefined) hints.y = "continuous";
  }

  for (const { idx, select } of interactors) {
    const inv = INVERTING_INTERACTORS[select];
    if (!inv) continue;  // toggle/nearest/highlight — work on any scale
    const path = `${plotPath}/${idx}`;
    const xBad = inv.x && hints.x === "categorical";
    const yBad = inv.y && hints.y === "categorical";
    if (!xBad && !yBad) continue;

    out.push({
      path,
      severity: "error",
      selector: select,
      message: buildMessage(select, xBad, yBad, forcingMarks),
    });
  }

  // Detect `intervalX` + `intervalY` paired on the same plot writing to the
  // same selection target. They look like they'd combine into a 2D brush,
  // but D3 attaches each as its own brush behavior on the SVG element —
  // they fight for pointer events and publish independent 1D clauses
  // instead of a coordinated 2D one. The canonical fix is a single
  // `intervalXY` interactor on that plot.
  const intervalEntries = plotArray
    .map((e, i) => ({ idx: i, entry: e }))
    .filter((p) => p.entry && typeof p.entry === "object" &&
      (p.entry.select === "intervalX" || p.entry.select === "intervalY"));
  // Group by the `as` target — only paired interactors writing to the SAME
  // selection are problematic. Independent selections are fine.
  const byTarget = new Map<string, typeof intervalEntries>();
  for (const e of intervalEntries) {
    const target = typeof e.entry.as === "string" ? e.entry.as : "<no-target>";
    const list = byTarget.get(target) || [];
    list.push(e);
    byTarget.set(target, list);
  }
  for (const [target, list] of byTarget) {
    const hasX = list.some((e) => e.entry.select === "intervalX");
    const hasY = list.some((e) => e.entry.select === "intervalY");
    if (!hasX || !hasY) continue;
    // Flag both interactors, but emit one issue per plot so the agent
    // gets a single actionable message.
    const xIdx = list.find((e) => e.entry.select === "intervalX")!.idx;
    out.push({
      path: `${plotPath}/${xIdx}`,
      severity: "error",
      selector: "intervalX",
      message:
        `\`intervalX\` and \`intervalY\` on the same plot writing to the same selection (\`${target}\`) ` +
        `do not compose into a 2D brush — D3 attaches each as its own brush behavior on the SVG element, ` +
        `they fight for pointer events, and they publish independent 1D clauses rather than one coordinated 2D selection. ` +
        `Replace both interactors with a single \`{ "select": "intervalXY", "as": "${target}" }\`.`,
    });
  }
}

function buildMessage(
  select: string,
  xBad: boolean,
  yBad: boolean,
  forcing: { x?: string; y?: string },
): string {
  const badAxes: string[] = [];
  if (xBad) badAxes.push(`X (because mark "${forcing.x}" makes X categorical)`);
  if (yBad) badAxes.push(`Y (because mark "${forcing.y}" makes Y categorical)`);
  const fix = recommendFix(select, xBad, yBad);
  return (
    `\`select: "${select}"\` is a continuous-axis brush that calls \`scale.invert\`. ` +
    `It will crash on brush-drag because: ${badAxes.join(" AND ")}. ` +
    `Categorical axes use band/point scales which don't have \`.invert\`. ${fix}`
  );
}

function recommendFix(select: string, xBad: boolean, yBad: boolean): string {
  switch (select) {
    case "intervalX":
      return `Use \`select: "toggleX"\` instead (click to add/remove categories).`;
    case "intervalY":
      return `Use \`select: "toggleY"\` instead (click to add/remove categories).`;
    case "interval":
    case "intervalXY":
      if (xBad && yBad) {
        return `Use \`select: "toggle"\` (both axes are categorical).`;
      }
      if (xBad) {
        return `Replace \`${select}\` with \`select: "intervalY"\` to brush only the continuous Y axis, OR \`select: "toggleX"\` if you want to select categories.`;
      }
      // yBad only
      return `Replace \`${select}\` with \`select: "intervalX"\` to brush only the continuous X axis, OR \`select: "toggleY"\` if you want to select categories.`;
    case "panZoom":
    case "panZoomX":
    case "panZoomY":
      return `Pan/zoom requires continuous scales on the panned axes — categorical axes cannot pan/zoom. Either remove the pan/zoom interactor or use a different mark for the categorical axis.`;
    default:
      return "";
  }
}

/**
 * Format lint issues for inclusion in a tool error message. Mirrors
 * `formatValidationErrors` in mosaic-validator.ts so both kinds of
 * pre-render feedback look the same to the agent.
 */
export function formatLintIssues(issues: MosaicLintIssue[]): string {
  if (issues.length === 0) return "(no issues)";
  return issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
}

// ─── Column-type-aware lint pass ────────────────────────────────────────
//
// The mark-based heuristic above catches the easy cases (barY+intervalX,
// cell+intervalXY) but misses free-form marks where axis types depend on
// data — e.g. `mark: "dot"` with `y: "track"` where `track` is a string
// column. That's a runtime crash waiting to happen. To catch it, we need
// to know the actual column types from DuckDB.
//
// `lintMosaicSpecWithTypes` does an extra async pass: resolve each plot's
// data source to its top-level SQL, run `DESCRIBE` on that SQL to extract
// column types, then check every interval/panZoom interactor against the
// types of the columns referenced by its X/Y channels.
//
// Costs one `DESCRIBE (<sql>)` per unique top-level data source. DESCRIBE
// doesn't execute the underlying query — it just returns column metadata
// — so this is cheap (~10-30ms per data source).

export type LintQueryRunner = (sql: string) => Promise<{
  ok: boolean;
  arrowBuffers?: (ArrayBuffer | Uint8Array)[];
  error?: string;
}>;

interface ColumnInfo { name: string; type: string }

/**
 * Run mark-based lint plus column-type-aware lint. Returns the combined
 * set of issues. Falls back to mark-based-only if `runQuery` is omitted,
 * or if any DESCRIBE call fails.
 */
export async function lintMosaicSpecWithTypes(
  spec: unknown,
  runQuery?: LintQueryRunner,
): Promise<MosaicLintIssue[]> {
  const staticIssues = lintMosaicSpec(spec);
  if (!runQuery) return staticIssues;

  // Build a sourceName → SQL map from the top-level `data:` block.
  const dataDefs = (spec as any)?.data;
  if (!dataDefs || typeof dataDefs !== "object") return staticIssues;
  const sqlBySource = new Map<string, string>();
  for (const [name, value] of Object.entries(dataDefs)) {
    const sql = coerceDataDefToSql(value);
    if (sql) sqlBySource.set(name, sql);
  }
  if (sqlBySource.size === 0) return staticIssues;

  // Run DESCRIBE for every distinct source once. Cache by SQL string.
  const typesBySource = new Map<string, Map<string, string>>();
  for (const [name, sql] of sqlBySource) {
    const cols = await describeColumns(runQuery, sql);
    if (cols) {
      const map = new Map<string, string>();
      for (const c of cols) map.set(c.name, c.type);
      typesBySource.set(name, map);
    }
  }
  if (typesBySource.size === 0) return staticIssues;

  // Walk plots again — this time with type info.
  const dynamicIssues: MosaicLintIssue[] = [];
  walkPlotContainers(spec, "", (plotPath, plotArray) => {
    lintPlotWithTypes(plotPath, plotArray, typesBySource, staticIssues, dynamicIssues);
  });

  // Merge static + dynamic. Static issues take precedence at a given path
  // (more specific message with the offending mark name), so dynamic-only
  // entries fill in the gaps.
  const seenPaths = new Set(staticIssues.map((i) => i.path));
  return [...staticIssues, ...dynamicIssues.filter((i) => !seenPaths.has(i.path))];
}

/**
 * Extract a SQL query string from a Mosaic top-level data definition. The
 * Mosaic data-source object has many forms; we only run DESCRIBE on the
 * SQL-bearing ones (`table` + `query`, bare strings post-normalization).
 * File/URL-loaded sources are skipped — we'd need to load them to get
 * column types, which defeats the cheap-lint goal.
 */
function coerceDataDefToSql(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.query === "string") return v.query;
  if (typeof v.sql === "string") return v.sql;
  return null;
}

/**
 * DESCRIBE a SQL query and return its column name → DuckDB type mapping.
 * Returns null on any error so the caller can degrade gracefully — a
 * broken query at lint time will be caught by the full pre-render anyway.
 */
async function describeColumns(
  runQuery: LintQueryRunner,
  sql: string,
): Promise<ColumnInfo[] | null> {
  // Trim trailing `;` to avoid double-statement parse errors after wrapping.
  const clean = sql.trim().replace(/;+\s*$/g, "");
  try {
    const r = await runQuery(`DESCRIBE (${clean})`);
    if (!r.ok || !r.arrowBuffers?.[0]) return null;
    return parseDescribeResult(r.arrowBuffers[0]);
  } catch {
    return null;
  }
}

/** Decode the Arrow buffer from a DESCRIBE result into ColumnInfo[]. The
 *  DuckDB DESCRIBE schema is: column_name, column_type, null, key, default,
 *  extra — we only need the first two. */
function parseDescribeResult(buf: ArrayBuffer | Uint8Array): ColumnInfo[] | null {
  try {
    const { tableFromIPC } = require("@uwdata/flechette") as typeof import("@uwdata/flechette");
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    const table = tableFromIPC(bytes);
    const rows = table.toArray() as Array<{ column_name?: string; column_type?: string }>;
    return rows
      .map((r) => ({ name: r.column_name || "", type: r.column_type || "" }))
      .filter((r) => r.name);
  } catch {
    return null;
  }
}

/** Lint a single plot using known column types per data source. */
function lintPlotWithTypes(
  plotPath: string,
  plotArray: any[],
  typesBySource: Map<string, Map<string, string>>,
  alreadyFlagged: MosaicLintIssue[],
  out: MosaicLintIssue[],
): void {
  // Collect marks + interactors + the marks' data sources.
  const marks: Array<{ idx: number; entry: any }> = [];
  const interactors: Array<{ idx: number; select: string }> = [];
  for (let i = 0; i < plotArray.length; i++) {
    const e = plotArray[i];
    if (!e || typeof e !== "object") continue;
    if (typeof e.mark === "string") marks.push({ idx: i, entry: e });
    if (typeof e.select === "string") interactors.push({ idx: i, select: e.select });
  }
  if (interactors.length === 0 || marks.length === 0) return;

  const flagged = new Set(alreadyFlagged.map((i) => i.path));

  for (const { idx, select } of interactors) {
    const path = `${plotPath}/${idx}`;
    if (flagged.has(path)) continue;  // already caught by mark-based pass

    const inv = INVERTING_INTERACTORS[select];
    if (!inv) continue;

    // For every mark that shares this plot, determine if its X/Y channel
    // points at a non-numeric column. Any such mark forces the axis type
    // to categorical for interactor purposes.
    const xBad = inv.x && plotHasCategoricalAxisFromTypes("x", marks, typesBySource);
    const yBad = inv.y && plotHasCategoricalAxisFromTypes("y", marks, typesBySource);
    if (!xBad.bad && !yBad.bad) continue;

    out.push({
      path,
      severity: "error",
      selector: select,
      message: buildTypeMessage(
        select,
        xBad.bad ? xBad : null,
        yBad.bad ? yBad : null,
      ),
    });
  }
}

interface AxisDiagnosis {
  bad: boolean;
  /** Column name referenced by the channel. */
  column?: string;
  /** DuckDB type string. */
  type?: string;
  /** Source name in the spec's `data` block. */
  source?: string;
}

/** For axis "x" or "y": resolve which column it points at on each mark in
 *  the plot, look up that column's DuckDB type, and judge whether the
 *  resulting scale will be categorical (band/point) rather than
 *  continuous (linear/time). Returns the FIRST diagnosis that finds a
 *  categorical column — one bad mark in the plot is enough to corrupt
 *  the plot's scale type for interactor purposes. */
function plotHasCategoricalAxisFromTypes(
  axis: "x" | "y",
  marks: Array<{ idx: number; entry: any }>,
  typesBySource: Map<string, Map<string, string>>,
): AxisDiagnosis {
  for (const { entry } of marks) {
    const channel = entry[axis];
    const colName = extractColumnName(channel);
    if (!colName) continue;  // computed channel — can't introspect
    const sourceName = extractDataSourceName(entry.data);
    if (!sourceName) continue;
    const cols = typesBySource.get(sourceName);
    if (!cols) continue;
    const type = cols.get(colName);
    if (!type) continue;
    if (isCategoricalType(type)) {
      return { bad: true, column: colName, type, source: sourceName };
    }
  }
  return { bad: false };
}

/** Extract a bare column name from a mark channel. Returns null for
 *  computed channels like `{count: ""}`, `{sql: "..."}`, etc., since we
 *  can't introspect those without parsing SQL. */
function extractColumnName(channel: unknown): string | null {
  if (typeof channel === "string") return channel;
  // Some specs use { field: "col" } — Mosaic accepts it.
  if (channel && typeof channel === "object") {
    const c = channel as Record<string, unknown>;
    if (typeof c.field === "string") return c.field;
    if (typeof c.column === "string") return c.column;
  }
  return null;
}

/** Extract the source name a mark reads from. Mosaic's `data` block on a
 *  mark is typically `{from: "<topLevelName>", filterBy: ...}`. Other forms
 *  (inline arrays, file refs) are skipped — they have no DESCRIBE'able
 *  top-level mapping. */
function extractDataSourceName(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.from === "string") return d.from;
  return null;
}

/**
 * Decide whether a DuckDB type produces a categorical D3 scale. Numeric +
 * temporal types use continuous scales (`scaleLinear`, `scaleTime`) which
 * HAVE `.invert`. Strings, booleans, enums, blobs, etc. use band/point
 * scales which do NOT. Default: categorical (safer to over-flag than to
 * miss a runtime crash).
 */
function isCategoricalType(duckType: string): boolean {
  const t = duckType.toUpperCase();
  // Numeric — continuous.
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|REAL|FLOAT|DOUBLE|DECIMAL)/.test(t)) {
    return false;
  }
  // Temporal — continuous.
  if (/^(DATE|TIMESTAMP|TIME|INTERVAL)/.test(t)) return false;
  // Everything else (VARCHAR, BOOLEAN, ENUM, BLOB, UUID, …, list/struct/map of) → categorical.
  return true;
}

function buildTypeMessage(
  select: string,
  xBad: AxisDiagnosis | null,
  yBad: AxisDiagnosis | null,
): string {
  const reasons: string[] = [];
  if (xBad) reasons.push(`X (column "${xBad.column}" in data "${xBad.source}" is ${xBad.type} — categorical)`);
  if (yBad) reasons.push(`Y (column "${yBad.column}" in data "${yBad.source}" is ${yBad.type} — categorical)`);
  return (
    `\`select: "${select}"\` will crash on brush-drag: ${reasons.join(" AND ")}. ` +
    `Categorical columns produce band/point scales, which have no \`.invert\` method. ` +
    recommendFix(select, !!xBad, !!yBad)
  );
}
