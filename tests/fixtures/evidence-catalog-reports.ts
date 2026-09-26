import catalog from './evidence-catalog.json' with { type: 'json' };

/** Reports built from Evidence's own documented examples (see scripts/evidence-catalog.ts). */

export interface CatalogExample { title: string; source: string; skip?: string }
export interface CatalogComponent { render: string; category: string; wrapper: string; examples: CatalogExample[] }
export const CATALOG = catalog as CatalogComponent[];

/** Deterministic stand-ins for the demo tables the examples read, on the scale the
 * examples assume: from 2021, monthly sales of roughly 2–4.5M (their reference lines
 * sit at 2.5–4.5M, their delta target at 120M), with seasonality and yearly growth.
 * It runs through 2026 so "last 12 months" examples have data relative to today. */
// An in-memory database named `demo`: the engine's default database is the attached
// VGI catalog, where CREATE SCHEMA would go to the remote server.
export const DEMO_SETUP_SQL = `ATTACH IF NOT EXISTS ':memory:' AS demo;
-- Evidence documents some examples in ClickHouse SQL.
CREATE OR REPLACE TEMP MACRO toStartOfMonth(d) AS date_trunc('month', d);
CREATE OR REPLACE TABLE demo.main.daily_orders AS
SELECT CAST(row_number() OVER (ORDER BY d, c.category) AS INTEGER) AS order_id,
       CAST(d AS DATE) AS date, c.category,
       round(c.base * (1 + 0.3 * sin(2 * pi() * dayofyear(d) / 365.0 + c.phase)) * (1 + 0.15 * (year(d) - 2021)) * (1 + 0.04 * sin(dayofyear(d) * 1.7 + c.phase)), 2) AS total_sales,
       CAST(c.base / 60 * (1 + 0.1 * sin(dayofyear(d) * 0.9 + c.phase)) AS INTEGER) AS transactions,
       round(total_sales / transactions, 2) AS avg_transaction_value,
       -- Columns individual examples read: units sold, a product line, and an image.
       CAST(transactions * 1.6 AS INTEGER) AS quantity,
       ['Standard', 'Premium', 'Clearance'][1 + (dayofyear(d) % 3)] AS item,
       'https://placehold.co/32x32/png?text=' || left(c.category, 1) AS image_url
FROM range(DATE '2021-01-01', DATE '2027-01-01', INTERVAL 1 DAY) AS t(d),
     (VALUES ('Electronics', 36000, 0.0), ('Clothing', 24000, 0.4), ('Home', 19000, 0.9), ('Sports', 14000, 1.5), ('Books', 7000, 2.2)) AS c(category, base, phase);
CREATE OR REPLACE TABLE demo.main.order_details AS
SELECT i.category, i.item_name, CAST(12 + (row_number() OVER ()) * 7 % 40 AS INTEGER) AS quantity, i.price
FROM (VALUES ('Electronics', 'Headphones', 89.0), ('Electronics', 'Keyboard', 59.0), ('Electronics', 'Monitor', 239.0),
             ('Clothing', 'Jacket', 120.0), ('Clothing', 'Sneakers', 95.0), ('Home', 'Lamp', 45.0), ('Home', 'Blender', 70.0),
             ('Sports', 'Yoga mat', 30.0), ('Sports', 'Racket', 150.0), ('Books', 'Atlas', 40.0)) AS i(category, item_name, price);`;

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
