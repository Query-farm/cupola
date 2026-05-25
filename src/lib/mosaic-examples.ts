/* ── Mosaic example specs ──
 *
 * Bundles the 54 worked spec examples from the Mosaic docs site
 * (~/Development/mosaic/docs/public/specs/json) into the build via Vite's
 * `?raw` glob import. The AI can browse the index (titles + descriptions)
 * and read specific examples to learn the spec format by example.
 *
 * Note: examples reference data files via `file: "data/stocks.parquet"`
 * etc — these paths won't resolve in our app, so the AI shouldn't copy
 * the examples verbatim. They're reference material for *how* to compose
 * a spec; the AI substitutes its own data source ({ "sql": "..." } or
 * { "type": "table", "query": "..." }) when authoring a real chart.
 *
 * Re-copy when bumping the Mosaic version we depend on.
 */
const raw = import.meta.glob("./mosaic-examples/*.json", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

export interface ExampleSummary {
  name: string;
  title: string | null;
  description: string | null;
}

interface ExampleEntry {
  json: string;
  parsed: any;
}

const examples: Map<string, ExampleEntry> = new Map();

// Parse once at module load. ~700KB raw JSON → ~140 small AST nodes.
for (const [path, mod] of Object.entries(raw)) {
  // "./mosaic-examples/foo.json" → "foo"
  const name = path.split("/").pop()!.replace(/\.json$/, "");
  const json = mod.default;
  let parsed: any = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Skip malformed examples (shouldn't happen — these are vendor specs).
    continue;
  }
  examples.set(name, { json, parsed });
}

/**
 * Return a compact index of all bundled examples. Each entry has the
 * filename stem (used as the lookup key) plus the meta.title /
 * meta.description if the spec includes them. Total size ~3-5KB —
 * cheap to include in a single tool call response.
 */
export function listChartExamples(): ExampleSummary[] {
  const out: ExampleSummary[] = [];
  for (const [name, entry] of examples) {
    const meta = entry.parsed?.meta || {};
    out.push({
      name,
      title: typeof meta.title === "string" ? meta.title : null,
      description: typeof meta.description === "string"
        ? meta.description.trim().replace(/\s+/g, " ")
        : null,
    });
  }
  // Stable order by name.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return the raw JSON text of a single bundled example, or null if no
 * such example exists.
 */
export function getChartExample(name: string): string | null {
  const entry = examples.get(name);
  return entry ? entry.json : null;
}
