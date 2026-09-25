import { expect, test } from "bun:test";
import { Field, Int32, Int64, List, Struct, Utf8, Table, tableFromArrays, tableToIPC, vectorFromArray } from "@query-farm/apache-arrow";
import { fetchAttachedCatalog } from "../../src/lib/duckdb-catalog";
import { engine } from "../../src/lib/shell-bridge";

test('DuckDB metadata preserves VGI docs, semantic tags, columns and function arguments', async () => {
  const tags = { 'vgi.doc_llm': 'Use this catalog for prices.', 'vgi.semantic_catalog': '{"catalog_id":"prices"}' };
  const rows: Record<string, Record<string, unknown[]>> = {
    'duckdb_databases()': { comment: ['Catalog docs'], tags: [tags] },
    'duckdb_schemas()': { schema_name: ['main'], comment: ['Schema docs'], tags: [{ 'vgi.doc_md': 'Schema help' }] },
    'duckdb_tables()': { schema_name: ['main'], table_name: ['prices'], comment: ['Table docs'], tags: [{ 'vgi.semantic_entity': '{"entity_id":"prices"}' }] },
    'duckdb_views()': { schema_name: ['main'], view_name: ['latest'], sql: ['SELECT * FROM prices'] },
    'duckdb_columns()': { schema_name: ['main', 'main'], table_name: ['prices', 'latest'], column_name: ['price', 'price'], data_type: ['DOUBLE', 'DOUBLE'], is_nullable: [false, true], comment: ['Price in USD', 'Latest price'], tags: [{ 'vgi.semantic_member': '{"member_id":"price"}' }, { 'vgi.semantic_member': '' }] },
    'duckdb_functions()': { schema_name: ['main'], function_name: ['history'], function_type: ['table'], description: ['Price history'], tags: [{ 'vgi.doc_llm': 'Supply a ticker.' }], parameters: [['ticker']], parameter_types: [['VARCHAR']], categories: [['Finance']], examples: [[{ sql: "SELECT * FROM history('AAPL')", description: 'Apple prices', expected_output: 'Prices' }]] },
    'vgi_function_arguments()': { schema_name: ['main'], function_name: ['history'], function_type: ['table'], arg_name: ['ticker'], arg_type: ['VARCHAR'], is_named: [true], is_const: [true], arg_description: ['Ticker symbol'], arg_default: ['"AAPL"'], arg_choices: ['["AAPL","MSFT"]'], input_from_args: [false], field_index: [0] },
  };
  const previous = engine.query;
  engine.query = async sql => {
    const data = Object.entries(rows).find(([name]) => sql.includes(name))?.[1] ?? { empty: [] };
    const table = new Table(Object.fromEntries(Object.entries(data).map(([key, values]) => {
      const type = key === 'tags' ? new Struct(Object.keys(values[0] as object).map(name => new Field(name, new Utf8())))
        : key === 'examples' ? new List(new Field('item', new Struct(['sql', 'description', 'expected_output'].map(name => new Field(name, new Utf8())))))
        : ['parameters', 'parameter_types', 'categories'].includes(key) ? new List(new Field('item', new Utf8()))
        : undefined;
      return [key, type ? vectorFromArray(values, type) : vectorFromArray(values as Array<string | number | boolean | null>)];
    })));
    return { ok: true, arrowBuffers: [tableToIPC(table).slice().buffer as ArrayBuffer] };
  };
  try {
    const result = await fetchAttachedCatalog('secondary');
    expect(result.metadataError).toBeUndefined();
    expect(result.catalogTags).toEqual(tags);
    expect(result.catalogComment).toBe('Catalog docs');
    const schema = result.schemas[0];
    expect(schema.info.tags).toEqual({ 'vgi.doc_md': 'Schema help' });
    expect(schema.tables[0]).toMatchObject({ comment: 'Table docs', tags: { 'vgi.semantic_entity': '{"entity_id":"prices"}' }, _columnInfo: [{ name: 'price', nullable: false, comment: 'Price in USD', tags: { 'vgi.semantic_member': '{"member_id":"price"}' } }] });
    expect(schema.views[0].column_comments).toEqual({ price: 'Latest price' });
    expect(schema.functions[0]).toMatchObject({ description: 'Price history', tags: { 'vgi.doc_llm': 'Supply a ticker.' }, categories: ['Finance'], examples: [{ sql: "SELECT * FROM history('AAPL')", description: 'Apple prices', expected_output: 'Prices' }], _functionArgsDetailed: true, _functionArgs: [{ name: 'ticker', named: true, description: 'Ticker symbol', defaultValue: 'AAPL', choices: ['AAPL', 'MSFT'] }] });
  } finally { engine.query = previous; }
});

test('function examples in DuckDB VARCHAR lists remain available', async () => {
  const previous = engine.query;
  const table = new Table({
    schema_name: vectorFromArray(['main']),
    function_name: vectorFromArray(['history']),
    function_type: vectorFromArray(['table']),
    examples: vectorFromArray([["SELECT * FROM history('AAPL')", '']], new List(new Field('item', new Utf8()))),
  });
  engine.query = async sql => ({ ok: true, arrowBuffers: [tableToIPC(sql.includes('duckdb_functions()') ? table : tableFromArrays({ empty: [] })).slice().buffer as ArrayBuffer] });
  try {
    const catalog = await fetchAttachedCatalog('secondary');
    expect(catalog.metadataError).toBeUndefined();
    expect(catalog.schemas[0].functions[0].examples).toEqual([{ sql: "SELECT * FROM history('AAPL')", description: '', expected_output: null }]);
  } finally { engine.query = previous; }
});

for (const type of [new Int32(), new Int64()]) {
  test(`attached catalog preserves constraints from Arrow ${type} lists`, async () => {
    const indexes = type instanceof Int64 ? [[0n, 1n], [0n], [1n]] : [[0, 1], [0], [1]];
    const constraints = new Table({
      schema_name: vectorFromArray(["main", "main", "main"]),
      table_name: vectorFromArray(["prices", "prices", "prices"]),
      constraint_type: vectorFromArray(["PRIMARY KEY", "NOT NULL", "UNIQUE"]),
      constraint_column_indexes: vectorFromArray(indexes, new List(new Field("item", type))),
    });
    const previousQuery = engine.query;
    engine.query = async (sql) => {
      const table = sql.includes("duckdb_constraints()") ? constraints
        : sql.includes("duckdb_tables()") ? tableFromArrays({ schema_name: ["main"], table_name: ["prices"] })
        : tableFromArrays({ empty: [] });
      return { ok: true, ...(table ? { arrowBuffers: [tableToIPC(table).slice().buffer as ArrayBuffer] } : {}) };
    };
    try {
      const catalog = await fetchAttachedCatalog("secondary");
      expect(catalog.catalogName).toBe("secondary");
      expect(catalog.metadataError).toBeUndefined();
      expect(catalog.schemas[0].tables[0]).toMatchObject({
        name: "prices",
        primary_key_constraints: [[0, 1]],
        not_null_constraints: [0],
        unique_constraints: [[1]],
      });
    } finally {
      engine.query = previousQuery;
    }
  });
}
