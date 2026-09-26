import catalog from './evidence-catalog.json' with { type: 'json' };

/** Reports built from Evidence's own documented examples (see scripts/evidence-catalog.ts). */

export interface CatalogExample { title: string; source: string; skip?: string }
export interface CatalogComponent { render: string; category: string; wrapper: string; examples: CatalogExample[] }
export const CATALOG = catalog as CatalogComponent[];

/** The examples read `demo.daily_orders` / `demo.order_details`, which Cupola's test
 * service serves as its `demo` schema (~/Development/vgi-cupola-test, src/demo.ts): on
 * the scale the examples assume, from 2021, monthly sales of roughly 2–4.5M (their
 * reference lines sit at 2.5–4.5M, their delta target at 120M), with seasonality and
 * yearly growth, through 2026 so "last 12 months" examples have data relative to today.
 * The service is the attached (default) catalog, so `demo.<table>` resolves to it.
 * These reports must run against that service (EVIDENCE_SERVICE_URL in helpers.ts).
 * Seeding an in-memory database named `demo` here instead would make every
 * `demo.<table>` an ambiguous catalog-or-schema reference. */
// Evidence documents some examples in ClickHouse SQL.
export const DEMO_SETUP_SQL = `CREATE OR REPLACE TEMP MACRO toStartOfMonth(d) AS date_trunc('month', d);`;

/** Components whose documented examples cannot run on their own, with a fixture that does. */
const EXTRA_EXAMPLES: Record<string, CatalogExample[]> = {
  progress_bars: [{ title: 'Share of transactions by category', source: '{% progress_bars data="demo.daily_orders" dimension="category" numerator="sum(total_sales) FILTER (WHERE year(date) = 2024)" denominator="sum(total_sales)" title="2024 share of two-year sales" /%}' }],
  heat_grid: [{ title: 'Average order value by category', source: '{% heat_grid data="demo.daily_orders" dimension="category" value="avg(avg_transaction_value)" thresholds=[58, 62] units="USD" fmt="0.0" title="Average transaction value" /%}' }],
  line_break: [{ title: 'Two blank lines', source: 'Before the break.\n\n{% line_break lines=2 /%}\n\nAfter the break.' }],
  html_table: [{ title: 'Markdown table', source: '| Category | Target |\n|---|---:|\n| Electronics | 1,800 |\n| Books | 400 |' }],
};

/** The reports a full run renders: one per component family, each small enough to settle quickly. */
export const CATALOG_GROUPS: { id: string; title: string; categories: string[]; renders?: (render: string) => boolean }[] = [
  { id: 'charts-a', title: 'Charts A–F', categories: ['chart'], renders: r => r < 'g' },
  { id: 'charts-b', title: 'Charts G–Z', categories: ['chart'], renders: r => r >= 'g' },
  { id: 'chart-parts', title: 'Chart series, references and sparklines', categories: ['chart_slot'] },
  { id: 'tables', title: 'Tables', categories: ['table'] },
  { id: 'values', title: 'Values and logic', categories: ['value', 'logic'] },
  { id: 'layout', title: 'Layout and content', categories: ['ui'] },
  { id: 'inputs', title: 'Inputs', categories: ['input'] },
  { id: 'maps', title: 'Maps', categories: ['map', 'map_slot'] },
];

/** Give an example's query names and input ids a unique prefix, so examples that
 * reuse `category_filter` or `filtered_orders` can share one report. */
export function isolate(source: string, prefix: string): string {
  const names = new Set([
    ...[...source.matchAll(/```sql\s+(\w+)/g)].map(m => m[1]),
    ...[...source.matchAll(/\bid="(\w+)"/g)].map(m => m[1]),
  ]);
  let out = source;
  for (const name of names) out = out.replace(new RegExp(`(?<![\\w.])${name}(?!\\w)`, 'g'), `${prefix}_${name}`);
  return out;
}

export interface CatalogReport { id: string; title: string; source: string; renders: string[]; examples: number }

export function catalogReports(): CatalogReport[] {
  return CATALOG_GROUPS.map(group => {
    const components = CATALOG.filter(c => group.categories.includes(c.category) && (!group.renders || group.renders(c.render)));
    const sections: string[] = [`# Evidence catalog: ${group.title}`];
    let count = 0;
    for (const component of components) {
      const examples = [...component.examples, ...(EXTRA_EXAMPLES[component.render] ?? [])].filter(example => !example.skip);
      if (!examples.length) continue;
      sections.push(`## ${component.render}`);
      for (const example of examples) {
        count++;
        sections.push(`### ${example.title.replace(/`/g, '')}`, isolate(example.source, `x${count}`));
      }
    }
    return { id: group.id, title: `Evidence catalog: ${group.title}`, source: sections.join('\n\n') + '\n', renders: components.map(c => c.render), examples: count };
  });
}

/** One report per component, for side-by-side review of a single component's examples. */
export function catalogComponentReports(): (CatalogReport & { render: string; titles: string[] })[] {
  return CATALOG.flatMap(component => {
    const examples = [...component.examples, ...(EXTRA_EXAMPLES[component.render] ?? [])].filter(example => !example.skip);
    if (!examples.length) return [];
    const titles = examples.map(example => example.title.replace(/`/g, ''));
    const source = [`# ${component.render}`, ...examples.flatMap((example, i) => [`### ${titles[i]}`, isolate(example.source, `x${i + 1}`)])].join('\n\n') + '\n';
    return [{ id: `component-${component.render.replaceAll('_', '-')}`, render: component.render, title: component.render, source, renders: [component.render], examples: examples.length, titles }];
  });
}
