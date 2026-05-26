/* ── Mosaic JSON-schema introspection for the AI agent ──
 *
 * The full Mosaic schema is 8.6 MB / ~2M tokens — too large to send back
 * as a tool result. But it has 216 named definitions whose median size is
 * ~1.3 KB / ~400 tokens, and median-to-95th-percentile fits comfortably in
 * a tool response. So we expose:
 *
 *   - listSchemaDefinitions() — every definition's name plus a one-line hint
 *   - readSchemaDefinition(name) — the raw definition object for one name
 *
 * Agents land in this module after `generate_chart` returns validation
 * errors that name a specific schema path (e.g. `#/definitions/Plot/...`).
 * The validator includes a `definitionHint` per error pointing at the
 * relevant definition name, so the agent can call `read_chart_schema(name)`
 * directly without first having to browse the list.
 */

let _schema: any | null = null;
let _schemaPromise: Promise<any> | null = null;

async function loadSchema(): Promise<any> {
  if (_schema) return _schema;
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = import("./mosaic-schema.json").then((m: any) => {
    _schema = m.default ?? m;
    return _schema;
  });
  return _schemaPromise;
}

/**
 * One row in the definitions index. The `kind` is a coarse classification
 * derived from each definition's own JSON-schema shape — useful for the
 * agent to filter the index ("show me marks", "show me transforms").
 */
export interface DefinitionIndexEntry {
  name: string;
  /** Bytes of the JSON representation — lets the agent decide whether to fetch. */
  size: number;
  /** Best-effort one-line title pulled from the definition's own `description`. */
  hint?: string;
  /** Coarse classification: "mark" / "transform" / "selection" / "layout" /
   *  "data" / "scale" / "other". Inferred from the definition's shape and
   *  name — not a schema attribute. Useful as a filter, not as ground truth. */
  kind: string;
}

export async function listSchemaDefinitions(): Promise<DefinitionIndexEntry[]> {
  const schema = await loadSchema();
  const defs = schema.definitions || {};
  const entries: DefinitionIndexEntry[] = [];
  for (const [name, def] of Object.entries(defs)) {
    const json = JSON.stringify(def);
    entries.push({
      name,
      size: json.length,
      hint: extractHint(def),
      kind: classify(name, def),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Return one definition by name. Returns `null` if the name isn't in the
 * schema (caller should surface a clear "not found, here's the index" hint
 * to the agent so it can retry).
 *
 * `Spec` is intentionally rejected — it's 2.3 MB because it inlines every
 * top-level alternative. Agents who want the spec shape should browse
 * specific definitions (Plot, MarkPlot, HConcat, etc.) instead.
 */
export async function readSchemaDefinition(name: string): Promise<unknown | null> {
  const schema = await loadSchema();
  const defs = schema.definitions || {};
  if (!(name in defs)) return null;
  if (name === "Spec") {
    return {
      _error:
        "The 'Spec' definition is 2.3 MB because it inlines every top-level alternative. " +
        "It's too large to return. Browse specific definitions instead — e.g. 'Plot', " +
        "'HConcat', 'VConcat', 'Selection', or a specific mark name like 'BarY', " +
        "'Dot', 'Line', 'Area'. Call list_chart_schema_definitions to see all names.",
    };
  }
  return defs[name];
}

function extractHint(def: any): string | undefined {
  if (!def || typeof def !== "object") return undefined;
  const desc = typeof def.description === "string" ? def.description : "";
  if (!desc) return undefined;
  // First sentence up to ~140 chars.
  const firstStop = desc.search(/[.!?]\s/);
  const trimmed = (firstStop > 0 ? desc.slice(0, firstStop + 1) : desc).replace(/\s+/g, " ").trim();
  return trimmed.length > 140 ? trimmed.slice(0, 137) + "..." : trimmed;
}

/**
 * Heuristic kind-classification. We look at the name suffix first (most
 * Mosaic types follow consistent naming: *Mark, *Plot, *Selection, …) and
 * fall back to inspecting the shape's `properties.type`/`properties.mark`
 * `const` if present.
 */
function classify(name: string, def: any): string {
  // Structure-based first — the Mosaic schema doesn't follow a uniform
  // naming suffix (marks are named after what they draw: Bar, Dot, Line),
  // so the most reliable signal is the definition's own `required` /
  // `properties` shape.
  const props = def?.properties || {};
  const required: string[] = Array.isArray(def?.required) ? def.required : [];

  // A definition that PINS a `mark` const is a mark spec.
  if (props.mark?.const) return "mark";
  // A definition that PINS a `select` const is a transform spec.
  if (props.select?.const) return "transform";
  // Top-level layouts have these direct keys as required.
  if (required.includes("hconcat") || required.includes("vconcat")) return "layout";
  if (required.includes("plot")) return "plot";
  // Selection shapes typically have `select` AND `as`.
  if (props.as && props.select) return "selection";
  // Data sources usually pin `type` to an enum/const (parquet/csv/etc.).
  if (props.type?.enum || props.type?.const) return "data";

  // Name-suffix fallback for the few that follow a convention.
  if (/Selection$/.test(name) || /Intervals?$/.test(name)) return "selection";
  if (/Transform$/.test(name)) return "transform";
  if (/(HConcat|VConcat|Concat|Layout)$/.test(name)) return "layout";
  if (/(Plot|Subplot)$/.test(name)) return "plot";
  if (/(Scale|Curve|Interpolate)$/.test(name)) return "scale";
  if (/(Param|Ref|Literal)$/.test(name)) return "param";
  if (/(Input|Slider|Menu|Search|Table)$/.test(name)) return "input";
  if (/(Channel|Attribute|Value)$/.test(name)) return "channel";
  if (/Mark$/.test(name)) return "mark";

  return "other";
}

/**
 * Extract a likely-relevant definition name from an Ajv error's schemaPath.
 * The validator uses this to attach a definitionHint per error so the
 * agent has a one-step recovery path: read this definition, then retry.
 *
 * Examples:
 *   "#/definitions/MarkPlot/properties/mark/const"  →  "MarkPlot"
 *   "#/anyOf/8/properties/plot/items/anyOf"         →  null (top-level anyOf
 *     branches in this schema aren't named — agent should browse the index)
 */
export function definitionFromSchemaPath(schemaPath: string | undefined): string | null {
  if (!schemaPath) return null;
  const m = schemaPath.match(/\/definitions\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}
