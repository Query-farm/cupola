import type { EvidenceReport } from './reports';
import example from './open-meteo.md?raw';
import { weatherSetupSql } from './weather';

export function newEvidenceReport(serviceUrl: string, catalogName: string, weather = false): EvidenceReport {
  return {
    version: 1, id: crypto.randomUUID(), title: weather ? 'Your week outdoors' : 'Untitled report',
    source: weather ? example : '# My report\n\n```sql summary\nSELECT 1 AS value\n```\n\n{% table data="summary" /%}\n',
    setupSql: weather ? weatherSetupSql(catalogName) : '', serviceUrl,
    parameters: weather ? [
      { id: crypto.randomUUID(), key: 'city', label: 'US city', type: 'text', required: true, defaultValue: 'Glen Allen, VA' },
      { id: crypto.randomUUID(), key: 'comparison_city', label: 'Compare with', type: 'text', required: true, defaultValue: 'San Francisco, CA' },
    ] : [],
    values: {}, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

/** A drilldown example over the test service's `geo` schema (vgi-cupola-test): cascading
 *  country → state → city choices, a date range, and a drill path through the three. */
export function newDrillExampleReport(serviceUrl: string): EvidenceReport {
  const choice = (key: string, label: string, sql: string) => ({
    id: crypto.randomUUID(), key, label, type: 'select' as const, required: false, defaultValue: null, allowAll: true,
    options: { kind: 'query' as const, sql },
  });
  const where = "WHERE ($country_all OR country_code = $country) AND ($state_all OR state_code = $state) AND ($city_all OR city = $city)\n  AND month BETWEEN coalesce($period_start, DATE '2025-01-01') AND coalesce($period_end, DATE '2026-12-31')";
  return {
    version: 1, id: crypto.randomUUID(), title: 'Sales by place', serviceUrl, setupSql: '', values: {}, createdAt: Date.now(), updatedAt: Date.now(),
    parameters: [
      choice('country', 'Country', 'SELECT DISTINCT country_code AS value, country AS label FROM geo.places ORDER BY label'),
      choice('state', 'State', 'SELECT DISTINCT state_code AS value, state AS label FROM geo.places\nWHERE ($country_all OR country_code = $country) ORDER BY label'),
      choice('city', 'City', 'SELECT DISTINCT city AS value FROM geo.places\nWHERE ($country_all OR country_code = $country) AND ($state_all OR state_code = $state) ORDER BY value'),
      { id: crypto.randomUUID(), key: 'period', label: 'Months', type: 'date_range', required: false, defaultValue: { start: '2026-01-01', end: '2026-12-31' } },
    ],
    drillPaths: [{ id: 'places', label: 'All places', levels: ['country', 'state', 'city'] }],
    source: [
      '# Sales by place',
      '',
      'Click a bar or an underlined place to drill from countries to states to cities; the breadcrumb above steps back up.',
      '',
      '```sql by_place',
      'SELECT CASE WHEN $country_all THEN country WHEN $state_all THEN state ELSE city END AS place,',
      '       sum(orders) AS orders, sum(revenue) AS revenue',
      `FROM geo.sales ${where}`,
      'GROUP BY 1 ORDER BY revenue DESC',
      '```',
      '',
      '```sql by_month',
      'SELECT month, category, sum(revenue) AS revenue',
      `FROM geo.sales ${where}`,
      'GROUP BY ALL ORDER BY month',
      '```',
      '',
      '{% bar_chart data="by_place" x="place" y="revenue" title="Revenue by place" /%}',
      '',
      '{% line_chart data="by_month" x="month" y="revenue" series="category" title="Monthly revenue by category" /%}',
      '',
      '{% table data="by_place" /%}',
      '',
    ].join('\n'),
  };
}
