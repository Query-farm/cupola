/** A report over the Evidence test service's `geo` schema (country → state → city),
 *  with cascading query-backed parameters. See ~/Development/vgi-cupola-test/src/geo.ts. */
export function geoReport(serviceUrl: string) {
  const choice = (key: string, label: string, sql: string) => ({
    id: key, key, label, type: 'select', required: false, defaultValue: null, allowAll: true,
    options: { kind: 'query', sql },
  });
  return {
    version: 1, id: 'geo-parameters', title: 'Sales by place', serviceUrl, setupSql: '', createdAt: 1, updatedAt: 1, values: {},
    parameters: [
      choice('country', 'Country', 'SELECT DISTINCT country_code AS value, country AS label FROM geo.places ORDER BY label'),
      { ...choice('state', 'State', 'SELECT DISTINCT state_code AS value, state AS label FROM geo.places WHERE ($country_all OR country_code = $country) ORDER BY label'), filterColumn: 'state_code' },
      choice('city', 'City', 'SELECT DISTINCT city AS value FROM geo.places WHERE ($country_all OR country_code = $country) AND ($state_all OR state_code = $state) ORDER BY value'),
    ],
    source: [
      '# Sales by place',
      '',
      '```sql by_city',
      'SELECT city, state, sum(revenue) AS revenue FROM geo.sales',
      'WHERE ($country_all OR country_code = $country) AND ($state_all OR state_code = $state) AND ($city_all OR city = $city)',
      'GROUP BY city, state ORDER BY city',
      '```',
      '',
      '{% table data="by_city" page_size=50 /%}',
      '',
      '## Places',
      '',
      '```sql places',
      'SELECT city, state_code FROM geo.places ORDER BY city',
      '```',
      '',
      // Evidence's own filters= follows the parameter, through its filterColumn.
      '{% table data="places" filters=["state"] page_size=50 /%}',
      '',
    ].join('\n'),
  };
}

/** The geo report with a drill path: click a country, then a state, then a city. The chart and
 *  table group by whichever level is next, so each click moves one level down. */
export function geoDrillReport(serviceUrl: string) {
  const base = geoReport(serviceUrl);
  return {
    ...base, id: 'geo-drill', title: 'Revenue by area',
    drillPaths: [{ id: 'geo', label: 'All places', levels: ['country', 'state', 'city'] }],
    source: [
      '# Revenue by area',
      '',
      '```sql by_area',
      'SELECT CASE WHEN $country_all THEN country WHEN $state_all THEN state ELSE city END AS area, sum(revenue) AS revenue',
      'FROM geo.sales',
      'WHERE ($country_all OR country_code = $country) AND ($state_all OR state_code = $state) AND ($city_all OR city = $city)',
      'GROUP BY 1 ORDER BY 1',
      '```',
      '',
      '{% bar_chart data="by_area" x="area" y="revenue" title="Revenue" /%}',
      '',
      '{% table data="by_area" page_size=50 /%}',
      '',
    ].join('\n'),
  };
}
