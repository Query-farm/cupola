import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as transport from "@query-farm/vgi-rpc/connect";
import { Field, Float64, Schema, Utf8 } from "@query-farm/apache-arrow";
import { VgiClient, constraintRecord, serializeSchema } from "vgi/client";
import type { FunctionInfo, MacroOverload, SchemaInfo } from "vgi/client";
import { fetchCatalog } from "../../src/lib/service";

type Contents = Awaited<ReturnType<VgiClient["catalogContents"]>>["schemas"][number];
const attachId = new Uint8Array([1]);
const bytes = new Uint8Array([2, 3]);
const nestedPath = ["region", "public"];
const schemaInfo = (path: string[]): SchemaInfo => ({
  path, comment: "Schema docs", tags: { "vgi.doc_md": "Schema help" },
});
const fn = (name: string, function_type: FunctionInfo["function_type"]): FunctionInfo => ({
  name, function_type, schema_path: nestedPath, tags: { "vgi.doc_llm": "Function help" },
  arguments: bytes, output_schema: bytes, description: "Function docs", examples: [], categories: [],
  filter_semantic_profiles: [], additional_filter_functions: [], runtime_filter_algorithms: [],
  filter_evaluation_contexts: [], supports_batch_index: false, supports_splits: false,
  filters_exactly_applied: false, supports_positions: false, partition_kind: "NOT_PARTITIONED",
  order_dependent: "NOT_ORDER_DEPENDENT", distinct_dependent: "NOT_DISTINCT_DEPENDENT",
  supports_window: false, streaming_partitioned: false, has_finalize: false,
  source_order_dependent: false, sink_order_dependent: false, requires_input_batch_index: false,
  input_from_args: false, required_settings: [], required_secrets: [],
});
const emptyContents = (path: string[]): Contents => ({
  schema: schemaInfo(path), tables: [], views: [], scalar_functions: [], aggregate_functions: [],
  table_functions: [], scalar_macros: [], table_macros: [], indexes: [],
});
const columns = serializeSchema(new Schema([
  new Field("ticker", new Utf8(), false),
  new Field("price", new Float64(), true),
  new Field("issuer", new Utf8(), true),
]) as never);
const record = (spec: Omit<Parameters<typeof constraintRecord>[0], "schemaPath" | "table" | "enforcement" | "validation">) =>
  constraintRecord({ schemaPath: ["public"], table: "prices", enforcement: "ENFORCED", validation: "ALL_ROWS", ...spec });
const context = { timezone: "UTC", collation: "binary", default_order: "asc", default_null_order: "nulls_last", preserve_insertion_order: true };
const overload = (parameters: string[], definition: string, macro_type: string): MacroOverload => ({
  parameters: parameters.map((name) => ({ name })), definition, profile: "duckdb", schema_path: nestedPath, macro_type,
  evaluation_context: context,
});
const contents: Contents = {
  ...emptyContents(nestedPath),
  tables: [{
    name: "prices", schema_path: nestedPath, columns, comment: "Table docs",
    tags: { "vgi.semantic_entity": "prices" },
    constraints: [
      record({ id: "nn_ticker", kind: "NOT_NULL", columns: [["ticker"]] }),
      record({ id: "pk", kind: "PRIMARY_KEY", columns: [["ticker"]] }),
      record({ id: "uq", kind: "UNIQUE", columns: [["price"], ["issuer"]] }),
      record({ id: "positive", kind: "CHECK", columns: [], checkSql: "price > 0" }),
      record({ id: "fk_issuer", kind: "FOREIGN_KEY", columns: [["issuer"]], declaredName: "issuer_fk",
        references: { schemaPath: ["public"], table: "issuers", columns: [["id"]], constraintId: "pk" } }),
    ],
    write_result_modes: {}, supports_column_statistics: true, required_filters: [[["ticker"]], [["bbox", "xmin"], ["isin"]]],
  }],
  views: [{
    name: "latest", schema_path: nestedPath, tags: {}, definition: "SELECT * FROM prices",
    column_comments: { price: "Price in USD" }, aliases: [], security: "",
  }],
  scalar_functions: [fn("convert", "SCALAR")],
  aggregate_functions: [fn("total", "AGGREGATE")],
  table_functions: [fn("history", "TABLE")],
  scalar_macros: [{ name: "usd", schema_path: nestedPath, tags: {}, macro_type: "SCALAR", overloads: [overload(["price"], "price", "SCALAR")] }],
  table_macros: [{ name: "recent", schema_path: nestedPath, tags: {}, macro_type: "TABLE", overloads: [overload([], "SELECT * FROM prices", "TABLE")] }],
};
const allContents = [emptyContents(["zebra"]), contents, emptyContents(["main"]), emptyContents(["alpha"])];

const spies: { mockRestore(): void }[] = [];
afterEach(() => { spies.reverse().forEach(spy => spy.mockRestore()); spies.length = 0; });
function track<T extends { mockRestore(): void }>(spy: T): T { spies.push(spy); return spy; }

function setup(supported: boolean | undefined) {
  const close = mock(() => {});
  const unexpected = async () => { throw new Error("Unexpected RPC"); };
  track(spyOn(transport, "httpConnect")).mockReturnValue({
    call: unexpected, stream: unexpected, callRaw: unexpected, streamRaw: unexpected,
    describe: unexpected, resumeStream: unexpected, capabilities: unexpected,
    requestUploadUrls: unexpected, beginSession: () => {}, currentSessionToken: () => null,
    currentEchoHeaders: () => ({}), detachSession: () => null, endSession: unexpected, close,
  });
  const infos = track(spyOn(VgiClient.prototype, "catalogsInfo")).mockResolvedValue([
    { name: "demo", attach_option_specs: [], releases: [], implementation_version: "1.0.0" },
  ]);
  const attach = {
    attach_opaque_data: attachId, default_schema: "main", comment: "Catalog docs",
    tags: { "vgi.doc_md": "Catalog help" }, supports_transactions: false,
    supports_time_travel: false, catalog_version_frozen: false, catalog_version: 0,
    attach_opaque_data_required: true, settings: [], secret_types: [], attach_catalogs: [],
    supports_column_statistics: true, global_functions: [], global_function_prefix: "",
    supports_catalog_contents: supported ?? false,
  } satisfies Awaited<ReturnType<VgiClient["catalogAttach"]>>;
  if (supported === undefined) delete (attach as Partial<typeof attach>).supports_catalog_contents;
  const attachCall = track(spyOn(VgiClient.prototype, "catalogAttach")).mockResolvedValue(attach);
  const detach = track(spyOn(VgiClient.prototype, "catalogDetach")).mockResolvedValue();
  const bulk = track(spyOn(VgiClient.prototype, "catalogContents")).mockResolvedValue({
    catalog_version: 1, etag: "v1", not_modified: false, schemas: allContents,
  });
  const schemas = track(spyOn(VgiClient.prototype, "schemas")).mockResolvedValue(allContents.map(c => c.schema));
  const find = (path: string[]) => allContents.find(c => JSON.stringify(c.schema.path) === JSON.stringify(path))!;
  const tables = track(spyOn(VgiClient.prototype, "schemaContentsTables")).mockImplementation(async (_id, path) => find(path as string[]).tables);
  const views = track(spyOn(VgiClient.prototype, "schemaContentsViews")).mockImplementation(async (_id, path) => find(path as string[]).views);
  const functions = track(spyOn(VgiClient.prototype, "schemaContentsFunctions")).mockImplementation(async (_id, path, kind) => {
    const c = find(path as string[]);
    return kind === "SCALAR_FUNCTION" ? c.scalar_functions : kind === "AGGREGATE_FUNCTION" ? c.aggregate_functions : c.table_functions;
  });
  const macros = track(spyOn(VgiClient.prototype, "schemaContentsMacros")).mockImplementation(async (_id, path, kind) => {
    const c = find(path as string[]);
    return kind === "SCALAR_MACRO" ? c.scalar_macros : c.table_macros;
  });
  const indexes = track(spyOn(VgiClient.prototype, "schemaContentsIndexes")).mockResolvedValue([]);
  return { close, infos, attach: attachCall, detach, bulk, schemas, tables, views, functions, macros, indexes };
}

test("capable catalogs load once and preserve metadata, schema paths and all callable kinds", async () => {
  const calls = setup(true);
  const result = await fetchCatalog("https://worker.test/");
  const { catalog } = result;
  expect(result).toMatchObject({ specs: [], implementationVersion: "1.0.0", treeFromEngine: false, availableCatalogs: ["demo"] });
  expect(calls.bulk).toHaveBeenCalledTimes(1);
  expect(calls.bulk).toHaveBeenCalledWith(attachId, null);
  for (const method of [calls.schemas, calls.tables, calls.views, calls.functions, calls.macros, calls.indexes])
    expect(method).not.toHaveBeenCalled();
  expect(catalog).toMatchObject({
    catalogName: "demo", defaultSchema: "main", catalogComment: "Catalog docs",
    catalogTags: { "vgi.doc_md": "Catalog help" },
  });
  expect(catalog.schemas.map(s => s.info.name)).toEqual(["main", "alpha", "region.public", "zebra"]);
  const schema = catalog.schemas[2];
  expect(schema.info).toMatchObject({ name: "region.public", comment: "Schema docs", tags: { "vgi.doc_md": "Schema help" } });
  expect(schema.info).not.toHaveProperty("path");
  expect(schema.tables[0]).toMatchObject({ schema_name: "region.public", comment: "Table docs", tags: { "vgi.semantic_entity": "prices" }, required_filters: [["ticker"], ["bbox.xmin", "isin"]] });
  expect(schema.tables[0].columns).toBe(columns);
  expect(schema.tables[0]).toMatchObject({
    not_null_constraints: [0], primary_key_constraints: [[0]], unique_constraints: [[1, 2]], check_constraints: ["price > 0"],
    foreign_key_constraints: [{ columns: ["issuer"], referencedSchema: "public", referencedTable: "issuers", referencedColumns: ["id"], constraintName: "issuer_fk" }],
  });
  expect(schema.tables[0]).not.toHaveProperty("constraints");
  expect(schema.tables[0]).not.toHaveProperty("schema_path");
  expect(schema.views[0]).toMatchObject({ schema_name: "region.public", column_comments: { price: "Price in USD" } });
  expect(schema.functions.map(f => f.function_type)).toEqual(["SCALAR", "AGGREGATE", "TABLE"]);
  expect(schema.macros.map(m => m.macro_type)).toEqual(["SCALAR", "TABLE"]);
  expect(schema.macros.map(m => [m.parameters, m.definition])).toEqual([[["price"], "price"], [[], "SELECT * FROM prices"]]);
  for (const child of [...schema.functions, ...schema.macros]) expect(child.schema_name).toBe("region.public");
  expect(calls.detach).toHaveBeenCalledTimes(1);
  expect(calls.detach).toHaveBeenCalledWith(attachId);
  expect(calls.close).toHaveBeenCalledTimes(1);
});

for (const capability of [false, undefined]) {
  test(`catalogs with capability ${capability} use per-schema discovery without a bulk request`, async () => {
    const calls = setup(capability);
    const { catalog } = await fetchCatalog("https://worker.test/");
    expect(calls.bulk).not.toHaveBeenCalled();
    expect(calls.schemas).toHaveBeenCalledTimes(1);
    expect(calls.tables).toHaveBeenCalledWith(attachId, nestedPath, undefined);
    expect(catalog.schemas[2].functions.map(f => f.name)).toEqual(["convert", "total", "history"]);
    expect(catalog.schemas[2].macros.map(m => m.name)).toEqual(["usd", "recent"]);
  });
}

test("a failing advertised bulk endpoint falls back to the same catalog metadata", async () => {
  const calls = setup(true);
  const bulkCatalog = await fetchCatalog("https://worker.test/");
  calls.bulk.mockRejectedValue(new Error("catalog_contents unavailable"));
  expect(await fetchCatalog("https://worker.test/")).toEqual(bulkCatalog);
  expect(calls.bulk).toHaveBeenCalledTimes(2);
  expect(calls.schemas).toHaveBeenCalledTimes(1);
});

test("an invalid not_modified bulk response falls back instead of displaying an empty catalog", async () => {
  const calls = setup(true);
  calls.bulk.mockResolvedValue({ catalog_version: 1, etag: "v1", not_modified: true, schemas: [] });
  const { catalog } = await fetchCatalog("https://worker.test/");
  expect(catalog.schemas[2].tables[0].name).toBe("prices");
  expect(calls.schemas).toHaveBeenCalledTimes(1);
});

test("legacy services missing optional listings retain their available metadata", async () => {
  const calls = setup(false);
  calls.indexes.mockRejectedValue(new Error("Unknown method"));
  calls.macros.mockRejectedValue(new Error("Macros unsupported"));
  const { catalog } = await fetchCatalog("https://worker.test/");
  expect(calls.bulk).not.toHaveBeenCalled();
  expect(catalog.schemas[2].tables[0].name).toBe("prices");
  expect(catalog.schemas[2].functions.map(f => f.name)).toEqual(["convert", "total", "history"]);
  expect(catalog.schemas[2].macros).toEqual([]);
});

test("a schema discovery failure remains an error and detaches and closes the client", async () => {
  const calls = setup(false);
  calls.schemas.mockRejectedValue(new Error("Schemas unavailable"));
  await expect(fetchCatalog("https://worker.test/")).rejects.toThrow("Schemas unavailable");
  expect(calls.detach).toHaveBeenCalledTimes(1);
  expect(calls.detach).toHaveBeenCalledWith(attachId);
  expect(calls.close).toHaveBeenCalledTimes(1);
});

test("a workspace can bulk-load its requested catalog rather than the service's first catalog", async () => {
  const calls = setup(true);
  calls.infos.mockResolvedValue([
    { name: "first", attach_option_specs: [], releases: [] },
    { name: "demo", attach_option_specs: [], releases: [] },
  ]);
  const result = await fetchCatalog("https://worker.test/", { catalogName: "demo" });
  expect(calls.attach).toHaveBeenCalledWith("demo");
  expect(result.availableCatalogs).toEqual(["first", "demo"]);
  expect(result.catalog.catalogName).toBe("demo");
  expect(calls.bulk).toHaveBeenCalledTimes(1);
});

test("catalogs with attach options keep their tree in the engine without an option-less RPC attach", async () => {
  const calls = setup(true);
  const result = await fetchCatalog("https://worker.test/", { hasOptions: true });
  expect(result.treeFromEngine).toBe(true);
  expect(result.catalog.schemas).toEqual([]);
  expect(calls.attach).not.toHaveBeenCalled();
  expect(calls.bulk).not.toHaveBeenCalled();
  expect(calls.detach).not.toHaveBeenCalled();
  expect(calls.close).toHaveBeenCalledTimes(1);
});
