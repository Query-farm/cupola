import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildCatalog } from '../../scripts/evidence-catalog';
import { COMPONENT_HANDLING } from '../../src/lib/evidence/typst/components';
import { CATALOG, catalogReports, isolate } from '../fixtures/evidence-catalog-reports';

describe('Evidence component catalog', () => {
  test('the fixture matches the vendored Evidence core', async () => {
    // Regenerate with `bun scripts/evidence-catalog.ts` after upgrading @evidence/core.
    const fresh = JSON.stringify(await buildCatalog(), null, 1) + '\n';
    expect(readFileSync(new URL('../fixtures/evidence-catalog.json', import.meta.url), 'utf8')).toBe(fresh);
  });

  test('the PDF export classifies every registered component', () => {
    const registered = CATALOG.map(component => component.render);
    expect(registered.filter(render => !(render in COMPONENT_HANDLING))).toEqual([]);
    // And nothing stale: every classified component still exists.
    expect(Object.keys(COMPONENT_HANDLING).filter(render => !registered.includes(render))).toEqual([]);
  });

  test('every printable component has a runnable example in the catalog reports', () => {
    const reports = catalogReports();
    const sources = reports.map(report => report.source).join('\n');
    const inReports = new Set([...sources.matchAll(/\{%\s*(\w+)/g)].map(match => match[1]));
    // Markdown nodes are written as Markdown, not tags.
    if (/```\w/.test(sources)) inReports.add('fence');
    if (/^\|[-:| ]+\|$/m.test(sources)) inReports.add('html_table');
    if (/\]\(https?:/.test(sources)) inReports.add('link');
    const printable = CATALOG.filter(component => !['part', 'input'].includes(COMPONENT_HANDLING[component.render]));
    // Structural helpers only exist inside custom components or partial files.
    const untestable = new Set(['fill', 'slot', 'partial', 'conditional', 'accordion_body_slot']);
    expect(printable.map(c => c.render).filter(render => !inReports.has(render) && !untestable.has(render))).toEqual([]);
  });

  test('examples sharing a report get their own query names and input ids', () => {
    const source = '```sql orders\nSELECT 1\n```\n{% dropdown id="pick" data="orders" /%}\n{% table data="orders" where="x = {{pick}}" /%}\n{% table data="demo.orders" /%}';
    const isolated = isolate(source, 'x7');
    expect(isolated).toContain('```sql x7_orders');
    expect(isolated).toContain('id="x7_pick"');
    expect(isolated).toContain('data="x7_orders"');
    expect(isolated).toContain('{{x7_pick}}');
    // A qualified table name is not a query reference.
    expect(isolated).toContain('data="demo.orders"');
  });
});
