#!/usr/bin/env bun
/**
 * Builds tests/fixtures/evidence-catalog.json: every component the vendored
 * Evidence core registers, with the documented examples from its own schema.
 *
 * The PDF export tests render these examples as reports, so coverage follows the
 * core rather than a hand-kept list. Playwright cannot import the core's schema
 * modules itself (it does not transpile TypeScript inside node_modules), hence a
 * checked-in fixture; tests/unit/evidence-typst-catalog.test.ts fails when it is stale.
 *
 *   bun scripts/evidence-catalog.ts           # rewrite the fixture
 *   bun scripts/evidence-catalog.ts --check   # exit 1 if it is out of date
 */
import { Glob } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'node_modules/@evidence/core/src/user-components/';
const OUT = 'tests/fixtures/evidence-catalog.json';

export interface CatalogExample { title: string; source: string; skip?: string }
export interface CatalogComponent { render: string; category: string; wrapper: string; examples: CatalogExample[] }

/** The demo tables almost every documented example reads (`demo.daily_orders`, `demo.order_details`). */
export const DEMO_DATASETS = ['demo.daily_orders', 'demo.order_details'];

/** Documented examples that fail on screen in any DuckDB-backed report, by Evidence's
 * own doing. They would only re-test error printing, which other examples cover. */
const BROKEN_UPSTREAM: Record<string, string> = {
  'bar/Extra tooltip fields': 'nests a window function inside an aggregate, which DuckDB rejects',
  'dropdown/Using `where`': 'filters on an input with no default selection, so the SQL reads `category = )`',
  'dropdown/Using Inline SQL': 'filters on an input with no default selection, so the SQL is incomplete',
  'button_group/Using `where`': 'filters on an input with no default selection, so the SQL reads `category = )`',
  'button_group/Using Inline SQL': 'filters on an input with no default selection, so the SQL is incomplete',
  'table/Custom Grouping': 'aliases a dimension as the reserved word `group`, which Evidence does not quote',
};

/** Why an example cannot run in a Cupola report, or undefined when it can. */
function skipReason(source: string, key?: string): string | undefined {
  if (key && BROKEN_UPSTREAM[key]) return `fails in Evidence itself: ${BROKEN_UPSTREAM[key]}`;
  if (/\bmetric\s*=|\bmetrics\s*=/.test(source)) return 'uses the semantic metrics catalog, which Cupola reports do not configure';
  if (/\{%\s*partial\b/.test(source)) return 'includes a partial file';
  const defined = new Set([...source.matchAll(/```sql\s+(\w+)/g)].map(m => m[1]));
  const missing = [...source.matchAll(/\bdata="([^"]+)"/g)].map(m => m[1]).filter(name => !DEMO_DATASETS.includes(name) && !defined.has(name));
  if (missing.length) return `reads data it does not define (${[...new Set(missing)].join(', ')})`;
  return undefined;
}

export async function buildCatalog(): Promise<CatalogComponent[]> {
  const components: CatalogComponent[] = [];
  for (const kind of ['tags', 'nodes']) {
    for await (const file of new Glob(`${kind}/**/schema.ts`).scan(ROOT)) {
      const module = await import(`../${ROOT}${file}`);
      for (const schema of Object.values(module) as { render?: unknown; attributes?: unknown; category?: string; componentWrapper?: false | { display?: string }; examples?: { title?: string; example?: string }[] }[]) {
        if (!schema || typeof schema.render !== 'string' || !schema.attributes) continue;
        if (schema.render === 'echarts' || schema.render === 'ReactiveVariable') continue; // Not registered: see core's index.ts.
        components.push({
          render: schema.render,
          category: schema.category ?? 'ui',
          wrapper: schema.componentWrapper === false ? 'none' : schema.componentWrapper?.display ?? 'block',
          examples: (schema.examples ?? []).map(example => {
            const source = (example.example ?? '').trim();
            const skip = skipReason(source, `${schema.render}/${example.title ?? ''}`);
            return { title: example.title ?? 'Example', source, ...(skip ? { skip } : {}) };
          }),
        });
      }
    }
  }
  return components.sort((a, b) => a.render.localeCompare(b.render));
}

if (import.meta.main) {
  const next = JSON.stringify(await buildCatalog(), null, 1) + '\n';
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT, 'utf8'); } catch { /* Missing counts as stale. */ }
    if (current !== next) { console.error(`${OUT} is out of date: run bun scripts/evidence-catalog.ts`); process.exit(1); }
  } else {
    writeFileSync(OUT, next);
    const catalog = JSON.parse(next) as CatalogComponent[];
    const examples = catalog.flatMap(c => c.examples);
    console.log(`${catalog.length} components, ${examples.length} examples, ${examples.filter(e => !e.skip).length} runnable`);
  }
}
