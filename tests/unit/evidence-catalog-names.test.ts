import { expect, test } from 'bun:test';
import { indexCatalog, type ColumnRow } from '../../src/lib/evidence/catalog-names';

const col = (table_catalog: string, table_schema: string, table_name: string, column_name = 'id', data_type = 'INTEGER'): ColumnRow =>
  ({ table_catalog, table_schema, table_name, column_name, data_type });

// Two attached catalogs with the same main.orders, a demo catalog, a temp table and
// a table in a non-main schema of the default catalog.
const rows = [
  col('memory', 'main', 'orders', 'id'), col('memory', 'main', 'orders', 'total', 'DOUBLE'),
  col('sales_vgi', 'main', 'orders', 'order_id'),
  col('demo', 'main', 'daily_orders', 'date', 'DATE'),
  col('temp', 'main', 'cupola_weather', 'city', 'VARCHAR'),
  col('memory', 'reporting', 'orders', 'region', 'VARCHAR'),
];
const search = [{ catalog: 'temp', schema: 'main' }, { catalog: 'memory', schema: 'main' }];

test('same-named tables in different catalogs stay separate', () => {
  const { tables } = indexCatalog(rows, search);
  expect(tables.get('memory.main.orders')!.columns.map(c => c.name)).toEqual(['id', 'total']);
  expect(tables.get('sales_vgi.main.orders')!.columns.map(c => c.name)).toEqual(['order_id']);
  expect(tables.size).toBe(5);
});

test('short names resolve the way DuckDB resolves them', () => {
  const { aliases } = indexCatalog(rows, search);
  // Bare names: temp first, then the default database's current schema.
  expect(aliases.get('cupola_weather')).toBe('temp.main.cupola_weather');
  expect(aliases.get('orders')).toBe('memory.main.orders');
  // schema.table within the searched catalogs wins over catalog.table.
  expect(aliases.get('reporting.orders')).toBe('memory.reporting.orders');
  expect(aliases.get('main.orders')).toBe('memory.main.orders');
  // catalog.table reaches another catalog's main schema.
  expect(aliases.get('sales_vgi.orders')).toBe('sales_vgi.main.orders');
  expect(aliases.get('demo.daily_orders')).toBe('demo.main.daily_orders');
  // Full names resolve case-insensitively; a table outside the search path has no bare name.
  expect(aliases.get('sales_vgi.main.orders')).toBe('sales_vgi.main.orders');
  expect(aliases.get('daily_orders')).toBeUndefined();
});
