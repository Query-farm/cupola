import { describe, expect, test } from "bun:test";
import {
  compileSemanticQuery,
  type SemanticQuery,
} from "@/lib/semantic-compiler";
import { executeSemanticQuery } from "@/lib/ai-tool-executor";
import {
  buildSemanticEnvironment,
  resolveNestedType,
} from "@/lib/semantic-model";
import type { CatalogData, ColumnInfo } from "@/lib/service";

const j = JSON.stringify;

const fnArg = (name: string, type: string, position: number) => ({
  name,
  arrowType: type,
  duckdbType: type,
  nullable: false,
  named: false,
  positional: true,
  position,
  fieldIndex: position,
  isTableInput: false,
  isAnyType: false,
  isVarargs: false,
  isConst: false,
});

function functionCatalog(
  alias: string,
  catalogId: string,
  entityId: string,
  name: string,
  args: any[],
  members: any[],
  columns: Array<[string, string]>,
): CatalogData {
  return {
    catalogName: alias,
    catalogComment: null,
    catalogTags: { "vgi.semantic_catalog": j({ catalog_id: catalogId }) },
    defaultSchema: "main",
    schemas: [
      {
        info: { name: "main", comment: null, tags: {} } as any,
        tables: [],
        views: [],
        macros: [],
        functions: [
          {
            name,
            schema_name: "main",
            function_type: "TABLE",
            input_from_args: true,
            _functionArgsDetailed: true,
            _functionArgs: args,
            _functionReturn: {
              isTable: true,
              columns: columns.map(([columnName, duckdbType]) => ({
                name: columnName,
                arrowType: duckdbType,
                duckdbType,
                nullable: false,
              })),
            },
            tags: {
              "vgi.semantic_entity": j({
                entity_id: entityId,
                grain: [members[0].member_id],
                source: {
                  arguments: args.map((argument) => ({
                    argument: argument.name,
                    parameter: argument.name,
                  })),
                },
              }),
              "vgi.semantic_members": j(members),
            },
          } as any,
        ],
      },
    ],
  };
}

function catalog(
  alias: string,
  catalogId: string,
  entities: Array<{
    name: string;
    entityId: string;
    grain: string[];
    members: any[];
    columns: string[];
    relationships?: any[];
    requiredFilters?: string[][];
  }>,
  relationships: any[] = [],
): CatalogData {
  const tables = entities.map((entity) => ({
    name: entity.name,
    schema_name: "main",
    comment: null,
    tags: {
      "vgi.semantic_entity": j({
        entity_id: entity.entityId,
        grain: entity.grain,
      }),
      "vgi.semantic_members": j(entity.members),
      ...(entity.relationships
        ? { "vgi.semantic_relationships": j(entity.relationships) }
        : {}),
    },
    required_filters: entity.requiredFilters ?? [],
    _columnInfo: entity.columns.map(
      (name): ColumnInfo => ({
        name,
        arrowType: "VARCHAR",
        duckdbType: "VARCHAR",
        nullable: true,
      }),
    ),
  }));
  return {
    catalogName: alias,
    catalogComment: null,
    catalogTags: {
      "vgi.semantic_catalog": j({
        catalog_id: catalogId,
        binding_key: catalogId.split(".").at(-1),
      }),
      ...(relationships.length
        ? { "vgi.semantic_relationships": j(relationships) }
        : {}),
    },
    defaultSchema: "main",
    schemas: [
      {
        info: { name: "main", comment: null, tags: {} } as any,
        tables: tables as any,
        views: [],
        functions: [],
        macros: [],
      },
    ],
  };
}

const relationship = {
  relationship_id: "com.example.order_customer",
  from: { catalog_id: "com.example.sales", entity_id: "orders" },
  to: { catalog_id: "com.example.crm", entity_id: "customers" },
  from_cardinality: { min: 0, max: "many" },
  to_cardinality: { min: 1, max: 1 },
  predicate: [
    {
      from_member: "customer_id",
      to_member: "customer_id",
      nulls: "not_equal",
    },
  ],
};

const sales = () =>
  catalog("sales_runtime", "com.example.sales", [
    {
      name: "orders",
      entityId: "orders",
      grain: ["order_id"],
      columns: ["order_id", "customer_id", "amount"],
      relationships: [relationship],
      members: [
        { member_id: "order_id", kind: "identifier", column: "order_id" },
        { member_id: "customer_id", kind: "dimension", column: "customer_id" },
        { member_id: "amount", kind: "dimension", column: "amount" },
        {
          member_id: "revenue",
          kind: "measure",
          aggregation: "sum",
          member: "amount",
          additivity: "additive",
        },
      ],
    },
  ]);

const crm = (alias = "crm_runtime", reciprocal = false) =>
  catalog(alias, "com.example.crm", [
    {
      name: "customers",
      entityId: "customers",
      grain: ["customer_id"],
      columns: ["customer_id", "country"],
      relationships: reciprocal
        ? [
            {
              ...relationship,
              from: relationship.to,
              to: relationship.from,
              from_cardinality: relationship.to_cardinality,
              to_cardinality: relationship.from_cardinality,
              predicate: [
                {
                  from_member: "customer_id",
                  to_member: "customer_id",
                  nulls: "not_equal",
                },
              ],
            },
          ]
        : undefined,
      members: [
        { member_id: "customer_id", kind: "identifier", column: "customer_id" },
        { member_id: "country", kind: "dimension", column: "country" },
      ],
    },
  ]);

function weatherWithUnits(): CatalogData {
  const temperatureUnit = {
    ...fnArg("temperature_unit", "VARCHAR", 2),
    named: true,
    positional: false,
    position: undefined,
    defaultValue: "celsius",
    choices: ["celsius", "fahrenheit"],
  };
  const worker = functionCatalog(
    "weather",
    "farm.query.weather",
    "forecast",
    "forecast",
    [
      fnArg("latitude", "DOUBLE", 0),
      fnArg("longitude", "DOUBLE", 1),
      temperatureUnit,
    ],
    [
      {
        member_id: "time_key",
        kind: "identifier",
        column: "time",
        data_type: "TIMESTAMP",
      },
      {
        member_id: "temperature",
        kind: "dimension",
        column: "temperature",
        data_type: "DOUBLE",
        unit_parameter: {
          argument: "temperature_unit",
          values: { celsius: "Cel", fahrenheit: "[degF]" },
        },
      },
      {
        member_id: "average_temperature",
        kind: "measure",
        aggregation: "avg",
        member: "temperature",
        additivity: "non_additive",
      },
      {
        member_id: "humidity",
        kind: "dimension",
        column: "humidity",
        data_type: "DOUBLE",
      },
      {
        member_id: "average_humidity",
        kind: "measure",
        aggregation: "avg",
        member: "humidity",
        additivity: "non_additive",
        unit: "percent",
      },
    ],
    [
      ["time", "TIMESTAMP"],
      ["temperature", "DOUBLE"],
      ["humidity", "DOUBLE"],
    ],
  );
  const info = worker.schemas[0].functions[0] as any;
  const entity = JSON.parse(info.tags["vgi.semantic_entity"]);
  entity.source.arguments.find(
    (argument: any) => argument.argument === "temperature_unit",
  ).required = false;
  info.tags["vgi.semantic_entity"] = j(entity);
  return worker;
}

describe("semantic model compiler", () => {
  test("reports static and parameter-selected units without changing SQL semantics", () => {
    const weather = weatherWithUnits();
    const request: SemanticQuery = {
      measures: [
        {
          catalog_id: "farm.query.weather",
          entity_id: "forecast",
          member_id: "average_temperature",
        },
        {
          catalog_id: "farm.query.weather",
          entity_id: "forecast",
          member_id: "average_humidity",
        },
      ],
      parameters: { latitude: 52.52, longitude: 13.41 },
      compile_only: true,
    };
    const defaulted = compileSemanticQuery([weather], request);
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.plan.output_units).toEqual({
      average_temperature: "Cel",
      average_humidity: "percent",
    });

    const fahrenheit = compileSemanticQuery([weather], {
      ...request,
      parameters: { ...request.parameters, temperature_unit: "fahrenheit" },
    });
    expect(fahrenheit.ok).toBe(true);
    if (!fahrenheit.ok) return;
    expect(fahrenheit.plan.output_units?.average_temperature).toBe("[degF]");
    expect(fahrenheit.plan.parameters).toEqual([52.52, 13.41, "fahrenheit"]);

    const invalid = compileSemanticQuery([weather], {
      ...request,
      parameters: { ...request.parameters, temperature_unit: "kelvin" },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok)
      expect(invalid.diagnostics[0].code).toBe("unit_parameter_value_unmapped");
  });

  test("does not replace a correlated unit with the physical scalar default", () => {
    const weather = weatherWithUnits();
    const info = weather.schemas[0].functions[0] as any;
    const unitArgument = info._functionArgs.find(
      (argument: any) => argument.name === "temperature_unit",
    );
    unitArgument.named = false;
    unitArgument.positional = true;
    unitArgument.position = 2;
    const result = compileSemanticQuery([weather], {
      measures: [
        {
          catalog_id: "farm.query.weather",
          entity_id: "forecast",
          member_id: "average_temperature",
        },
      ],
      inputs: [
        {
          input_id: "locations",
          grain: ["location_id"],
          columns: [
            { name: "location_id", type: "VARCHAR" },
            { name: "latitude", type: "DOUBLE" },
            { name: "longitude", type: "DOUBLE" },
            { name: "temperature_unit", type: "VARCHAR" },
          ],
          rows: [["berlin", 52.52, 13.41, "fahrenheit"]],
        },
      ],
      source_bindings: [
        {
          entity: { catalog_id: "farm.query.weather", entity_id: "forecast" },
          driver: { input_id: "locations" },
          arguments: {
            latitude: { input_column: "latitude" },
            longitude: { input_column: "longitude" },
            temperature_unit: { input_column: "temperature_unit" },
          },
        },
      ],
      compile_only: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.output_units).toEqual({ average_temperature: null });
    expect(result.plan.unit_diagnostics?.[0].code).toBe(
      "unit_parameter_value_unresolved",
    );
    expect(result.plan.parameters).toContain("fahrenheit");
  });

  test("distinguishes false from unavailable correlated-input capability", () => {
    const weather = weatherWithUnits();
    const info = weather.schemas[0].functions[0] as any;
    const request: SemanticQuery = {
      measures: [
        {
          catalog_id: "farm.query.weather",
          entity_id: "forecast",
          member_id: "average_temperature",
        },
      ],
      inputs: [
        {
          input_id: "locations",
          grain: ["location_id"],
          columns: [
            { name: "location_id", type: "VARCHAR" },
            { name: "latitude", type: "DOUBLE" },
            { name: "longitude", type: "DOUBLE" },
          ],
          rows: [["berlin", 52.52, 13.41]],
        },
      ],
      source_bindings: [
        {
          entity: { catalog_id: "farm.query.weather", entity_id: "forecast" },
          driver: { input_id: "locations" },
          arguments: {
            latitude: { input_column: "latitude" },
            longitude: { input_column: "longitude" },
          },
        },
      ],
      compile_only: true,
    };
    info.input_from_args = false;
    const unsupported = compileSemanticQuery([weather], request);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok)
      expect(unsupported.diagnostics[0].code).toBe(
        "correlated_input_not_supported",
      );

    info.input_from_args = null;
    const unknown = compileSemanticQuery([weather], request);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(unknown.diagnostics[0].code).toBe(
        "correlated_input_capability_unknown",
      );

    const scalar = compileSemanticQuery([weather], {
      measures: [
        {
          catalog_id: "farm.query.weather",
          entity_id: "forecast",
          member_id: "average_temperature",
        },
      ],
      parameters: { latitude: 52.52, longitude: 13.41 },
      compile_only: true,
    });
    expect(scalar.ok).toBe(true);
  });

  test("rejects incomplete advertised dynamic-unit mappings", () => {
    const weather = weatherWithUnits();
    const info = weather.schemas[0].functions[0] as any;
    const members = JSON.parse(info.tags["vgi.semantic_members"]);
    members.find(
      (member: any) => member.member_id === "temperature",
    ).unit_parameter.values = { celsius: "Cel" };
    info.tags["vgi.semantic_members"] = j(members);
    const environment = buildSemanticEnvironment([weather]);
    expect(
      environment.diagnostics.some(
        (diagnostic) => diagnostic.code === "unit_parameter_choices_incomplete",
      ),
    ).toBe(true);
  });

  test("compiles inline and chained correlated function invocations", () => {
    const geocode = functionCatalog(
      "geo",
      "com.example.geo",
      "geocode",
      "geocode",
      [fnArg("latitude", "DOUBLE", 0), fnArg("longitude", "DOUBLE", 1)],
      [
        {
          member_id: "candidate_id",
          kind: "identifier",
          column: "candidate_id",
          data_type: "VARCHAR",
        },
        {
          member_id: "latitude",
          kind: "dimension",
          column: "latitude",
          data_type: "DOUBLE",
        },
        {
          member_id: "longitude",
          kind: "dimension",
          column: "longitude",
          data_type: "DOUBLE",
        },
      ],
      [
        ["candidate_id", "VARCHAR"],
        ["latitude", "DOUBLE"],
        ["longitude", "DOUBLE"],
      ],
    );
    const weather = functionCatalog(
      "weather",
      "farm.query.weather",
      "forecast",
      "forecast",
      [fnArg("latitude", "DOUBLE", 0), fnArg("longitude", "DOUBLE", 1)],
      [
        {
          member_id: "time_key",
          kind: "identifier",
          column: "time",
          data_type: "TIMESTAMP",
        },
        {
          member_id: "temperature",
          kind: "dimension",
          column: "temperature",
          data_type: "DOUBLE",
        },
        {
          member_id: "average_temperature",
          kind: "measure",
          aggregation: "avg",
          member: "temperature",
          additivity: "non_additive",
        },
      ],
      [
        ["time", "TIMESTAMP"],
        ["temperature", "DOUBLE"],
      ],
    );
    const result = compileSemanticQuery([geocode, weather], {
      measures: [
        {
          catalog_id: "farm.query.weather",
          entity_id: "forecast",
          member_id: "average_temperature",
        },
      ],
      dimensions: [
        {
          catalog_id: "com.example.geo",
          entity_id: "geocode",
          member_id: "latitude",
        },
      ],
      inputs: [
        {
          input_id: "locations",
          grain: ["location_id"],
          columns: [
            { name: "location_id", type: "VARCHAR" },
            { name: "latitude", type: "DOUBLE" },
            { name: "longitude", type: "DOUBLE" },
          ],
          rows: [
            ["berlin", 52.52, 13.41],
            ["tokyo", 35.69, 139.69],
          ],
        },
      ],
      source_bindings: [
        {
          entity: { catalog_id: "farm.query.weather", entity_id: "forecast" },
          driver: {
            entity: { catalog_id: "com.example.geo", entity_id: "geocode" },
            max_rows: 4,
          },
          arguments: {
            latitude: {
              member: {
                catalog_id: "com.example.geo",
                entity_id: "geocode",
                member_id: "latitude",
              },
            },
            longitude: {
              member: {
                catalog_id: "com.example.geo",
                entity_id: "geocode",
                member_id: "longitude",
              },
            },
          },
        },
        {
          entity: { catalog_id: "com.example.geo", entity_id: "geocode" },
          driver: { input_id: "locations" },
          arguments: {
            latitude: { input_column: "latitude" },
            longitude: { input_column: "longitude" },
          },
        },
      ],
      execution_limits: { max_invocations: 6 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sql.match(/CROSS JOIN LATERAL/g)).toHaveLength(2);
    expect(result.plan.fact_branches[0].result_grain).toEqual([
      "location_id",
      "candidate_id",
      "latitude",
    ]);
    expect(result.plan.fact_branches[0].estimated_invocations).toBe(6);
    expect(result.plan.parameters.slice(0, 3)).toEqual([
      "berlin",
      52.52,
      13.41,
    ]);
  });

  test("credits required filters applied to a bounded entity driver", () => {
    const sites = catalog("assets", "com.example.assets", [
      {
        name: "sites",
        entityId: "sites",
        grain: ["site_id"],
        columns: ["site_id", "latitude", "longitude", "site_name"],
        requiredFilters: [["site_id"]],
        members: [
          { member_id: "site_id", kind: "identifier", column: "site_id" },
          { member_id: "latitude", kind: "dimension", column: "latitude" },
          { member_id: "longitude", kind: "dimension", column: "longitude" },
          { member_id: "site_name", kind: "dimension", column: "site_name" },
        ],
      },
    ]);
    const weather = functionCatalog(
      "weather",
      "farm.query.weather",
      "forecast",
      "forecast",
      [fnArg("latitude", "VARCHAR", 0), fnArg("longitude", "VARCHAR", 1)],
      [
        {
          member_id: "time_key",
          kind: "identifier",
          column: "time",
          data_type: "TIMESTAMP",
        },
        {
          member_id: "temperature",
          kind: "dimension",
          column: "temperature",
          data_type: "DOUBLE",
        },
        {
          member_id: "average_temperature",
          kind: "measure",
          aggregation: "avg",
          member: "temperature",
          additivity: "non_additive",
        },
      ],
      [
        ["time", "TIMESTAMP"],
        ["temperature", "DOUBLE"],
      ],
    );
    const result = compileSemanticQuery([sites, weather], {
      measures: [
        {
          catalog_id: "farm.query.weather",
          entity_id: "forecast",
          member_id: "average_temperature",
        },
      ],
      dimensions: [
        {
          catalog_id: "com.example.assets",
          entity_id: "sites",
          member_id: "site_name",
        },
      ],
      source_bindings: [
        {
          entity: { catalog_id: "farm.query.weather", entity_id: "forecast" },
          driver: {
            entity: { catalog_id: "com.example.assets", entity_id: "sites" },
            max_rows: 2,
            filters: { member: "site_id", operator: "eq", value: "berlin" },
          },
          arguments: {
            latitude: {
              member: {
                catalog_id: "com.example.assets",
                entity_id: "sites",
                member_id: "latitude",
              },
            },
            longitude: {
              member: {
                catalog_id: "com.example.assets",
                entity_id: "sites",
                member_id: "longitude",
              },
            },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sql).toContain('WHERE "_source"."site_id" = ?');
    expect(result.plan.fact_branches[0].result_grain).toEqual([
      "site_id",
      "site_name",
    ]);
  });

  test("compiles a deterministic cross-catalog to-one enrichment", () => {
    const result = compileSemanticQuery([sales(), crm()], {
      measures: [
        {
          catalog_id: "com.example.sales",
          entity_id: "orders",
          member_id: "revenue",
        },
      ],
      dimensions: [
        {
          catalog_id: "com.example.crm",
          entity_id: "customers",
          member_id: "country",
        },
      ],
      compile_only: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.validation_scope).toBe("semantic");
    expect(result.plan.fact_branches).toHaveLength(1);
    expect(result.plan.sql).toContain(
      'FROM "sales_runtime"."main"."orders" AS _e0',
    );
    expect(result.plan.sql).toContain(
      'INNER JOIN "crm_runtime"."main"."customers" AS _e1',
    );
    expect(result.plan.sql).toContain('SUM(_e0."amount") AS "revenue"');
  });

  test("compiles typed spatial and repeated-field relationship predicates", () => {
    const compile = (rootMember: any, rootColumn: string, predicate: any) => {
      const relationship = {
        relationship_id: "com.example.geo.event_zone",
        from: { catalog_id: "com.example.geo", entity_id: "events" },
        to: { catalog_id: "com.example.geo", entity_id: "zones" },
        from_cardinality: { min: 0, max: "many" },
        to_cardinality: { min: 0, max: 1 },
        predicate: [predicate],
        conditions: [
          { side: "to", member: "zone_type", value: "district" },
        ],
      };
      const geo = catalog(
        "geo_runtime",
        "com.example.geo",
        [
          {
            name: "events",
            entityId: "events",
            grain: ["event_id"],
            columns: ["id", rootColumn],
            members: [
              { member_id: "event_id", kind: "identifier", column: "id" },
              rootMember,
              {
                member_id: "event_count",
                kind: "measure",
                aggregation: "count_rows",
                additivity: "additive",
              },
            ],
          },
          {
            name: "zones",
            entityId: "zones",
            grain: ["zone_id"],
            columns: ["id", "name", "type", "geometry"],
            members: [
              { member_id: "zone_id", kind: "identifier", column: "id" },
              { member_id: "zone_name", kind: "dimension", column: "name" },
              { member_id: "zone_type", kind: "dimension", column: "type" },
              {
                member_id: "geometry",
                kind: "dimension",
                column: "geometry",
                data_type: "GEOMETRY",
                hidden: true,
              },
            ],
          },
        ],
        [relationship],
      );
      return compileSemanticQuery([geo], {
        measures: [
          {
            catalog_id: "com.example.geo",
            entity_id: "events",
            member_id: "event_count",
          },
        ],
        dimensions: [
          {
            catalog_id: "com.example.geo",
            entity_id: "zones",
            member_id: "zone_name",
          },
        ],
      });
    };

    const spatial = compile(
      {
        member_id: "geometry",
        kind: "dimension",
        column: "geometry",
        data_type: "GEOMETRY",
        hidden: true,
      },
      "geometry",
      {
        from_member: "geometry",
        to_member: "geometry",
        operator: "spatial_within",
      },
    );
    expect(spatial.ok).toBe(true);
    if (spatial.ok)
      expect(spatial.plan.sql).toContain(
        'ST_Within(_e0."geometry", _e1."geometry")',
      );
    if (spatial.ok) {
      expect(spatial.plan.sql).toContain(
        '_e1."type" IS NOT DISTINCT FROM ?',
      );
      expect(spatial.plan.parameters).toEqual(["district"]);
    }

    const repeated = compile(
      {
        member_id: "connectors",
        kind: "dimension",
        column: "connectors",
        data_type: "STRUCT(connector_id VARCHAR)[]",
        hidden: true,
      },
      "connectors",
      {
        from_member: "connectors",
        to_member: "zone_id",
        operator: "list_contains",
        from_element_path: ["connector_id"],
      },
    );
    expect(repeated.ok).toBe(true);
    if (repeated.ok)
      expect(repeated.plan.sql).toContain(
        'list_contains(list_transform(_e0."connectors", _item -> _item."connector_id"), _e1."id")',
      );
  });

  test("merges a reversed reciprocal assertion and marks it corroborated", () => {
    const environment = buildSemanticEnvironment([
      sales(),
      crm("crm_runtime", true),
    ]);
    expect(environment.relationships).toHaveLength(1);
    expect(environment.relationships[0].resolutionStatus).toBe("resolved");
    expect(environment.relationships[0].attestation).toBe("corroborated");
  });

  test("rejects a traversal into a many side", () => {
    const result = compileSemanticQuery([sales(), crm()], {
      root_entity: { catalog_id: "com.example.crm", entity_id: "customers" },
      dimensions: [
        {
          catalog_id: "com.example.crm",
          entity_id: "customers",
          member_id: "country",
        },
        {
          catalog_id: "com.example.sales",
          entity_id: "orders",
          member_id: "order_id",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0].stage).toBe("fanout");
  });

  test("rejects multi-root measures with a stable diagnostic", () => {
    const other = catalog("other", "com.example.other", [
      {
        name: "events",
        entityId: "events",
        grain: ["event_id"],
        columns: ["event_id"],
        members: [
          { member_id: "event_id", kind: "identifier", column: "event_id" },
          {
            member_id: "events",
            kind: "measure",
            aggregation: "count_rows",
            additivity: "additive",
          },
        ],
      },
    ]);
    const result = compileSemanticQuery([sales(), other], {
      measures: [
        {
          catalog_id: "com.example.sales",
          entity_id: "orders",
          member_id: "revenue",
        },
        {
          catalog_id: "com.example.other",
          entity_id: "events",
          member_id: "events",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0].stage).toBe("multi_fact_not_supported");
  });

  test("requires an explicit binding when a logical catalog is attached twice", () => {
    const ambiguous = compileSemanticQuery(
      [sales(), crm("crm_a"), crm("crm_b")],
      {
        root_entity: { catalog_id: "com.example.crm", entity_id: "customers" },
        dimensions: [
          {
            catalog_id: "com.example.crm",
            entity_id: "customers",
            member_id: "country",
          },
        ],
      },
    );
    expect(ambiguous.ok).toBe(false);
    const bound = compileSemanticQuery([sales(), crm("crm_a"), crm("crm_b")], {
      root_entity: { catalog_id: "com.example.crm", entity_id: "customers" },
      dimensions: [
        {
          catalog_id: "com.example.crm",
          entity_id: "customers",
          member_id: "country",
        },
      ],
      bindings: { crm: "crm_b" },
      compile_only: true,
    });
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.plan.sql).toContain('FROM "crm_b"');
  });

  test("compile_only never calls either DuckDB query bridge", async () => {
    let calls = 0;
    const output = JSON.parse(
      await executeSemanticQuery(
        [sales()],
        {
          measures: [
            {
              catalog_id: "com.example.sales",
              entity_id: "orders",
              member_id: "revenue",
            },
          ],
          compile_only: true,
        },
        {
          query: async () => {
            calls++;
            throw new Error("must not run");
          },
          queryPrepared: async () => {
            calls++;
            throw new Error("must not prepare");
          },
        },
      ),
    );
    expect(output.ok).toBe(true);
    expect(output.plan.validation_scope).toBe("semantic");
    expect(calls).toBe(0);
  });

  test("rejects requests and metadata that do not match the canonical schemas", () => {
    const badRequest = compileSemanticQuery([sales()], {
      measures: [
        {
          catalog_id: "com.example.sales",
          entity_id: "orders",
          member_id: "revenue",
        },
      ],
      unexpected: true,
    } as any);
    expect(badRequest.ok).toBe(false);
    if (!badRequest.ok)
      expect(badRequest.diagnostics[0].code).toBe("query_schema");
    const missingFilterValue = compileSemanticQuery([sales()], {
      measures: [
        {
          catalog_id: "com.example.sales",
          entity_id: "orders",
          member_id: "revenue",
        },
      ],
      filters: { member: "order_id", operator: "eq" },
    } as any);
    expect(missingFilterValue.ok).toBe(false);
    if (!missingFilterValue.ok)
      expect(missingFilterValue.diagnostics[0].code).toBe("query_schema");

    const invalidEntity = sales();
    invalidEntity.schemas[0].tables[0].tags!["vgi.semantic_entity"] = j({
      entity_id: "orders",
      grain: ["order_id"],
      sql: "SELECT * FROM somewhere",
    });
    const badModel = compileSemanticQuery([invalidEntity], {
      measures: [
        {
          catalog_id: "com.example.sales",
          entity_id: "orders",
          member_id: "revenue",
        },
      ],
    });
    expect(badModel.ok).toBe(false);
    if (!badModel.ok)
      expect(badModel.diagnostics[0].code).toBe("semantic_schema");
  });

  test("enforces required filters on every joined source", () => {
    const customers = crm();
    customers.schemas[0].tables[0].required_filters = [["country"]];
    const request: SemanticQuery = {
      measures: [
        {
          catalog_id: "com.example.sales",
          entity_id: "orders",
          member_id: "revenue",
        },
      ],
      dimensions: [
        {
          catalog_id: "com.example.crm",
          entity_id: "customers",
          member_id: "country",
        },
      ],
    };
    const missing = compileSemanticQuery([sales(), customers], request);
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.diagnostics[0].code).toBe("required_filter_missing");

    const filtered = compileSemanticQuery([sales(), customers], {
      ...request,
      dimensions: [],
      filters: {
        member: {
          catalog_id: "com.example.crm",
          entity_id: "customers",
          member_id: "country",
        },
        operator: "eq",
        value: "US",
      },
    });
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.plan.sql).toContain('JOIN "crm_runtime"');
      expect(filtered.plan.parameters).toEqual(["US"]);
    }
  });

  test("compiles nested STRUCT fields and uses them to satisfy required filters", () => {
    const maps = catalog("maps_runtime", "farm.query.maps", [
      {
        name: "place",
        entityId: "place",
        grain: ["place_id"],
        columns: ["id", "basic_category", "bbox"],
        requiredFilters: [
          ["bbox.xmin"],
          ["bbox.xmax"],
          ["bbox.ymin"],
          ["bbox.ymax"],
        ],
        members: [
          { member_id: "place_id", kind: "identifier", column: "id" },
          {
            member_id: "category",
            kind: "dimension",
            column: "basic_category",
          },
          ...["xmin", "xmax", "ymin", "ymax"].map((axis) => ({
            member_id: `bbox_${axis}`,
            kind: "dimension",
            column_path: ["bbox", axis],
            data_type: "DOUBLE",
            unit: "deg",
            hidden: true,
          })),
          {
            member_id: "place_count",
            kind: "measure",
            aggregation: "count_rows",
            additivity: "additive",
          },
        ],
      },
    ]);
    (maps.schemas[0].tables[0] as any)._columnInfo.find(
      (column: ColumnInfo) => column.name === "bbox",
    )!.duckdbType =
      "STRUCT(xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE)";
    const result = compileSemanticQuery([maps], {
      measures: [
        {
          catalog_id: "farm.query.maps",
          entity_id: "place",
          member_id: "place_count",
        },
      ],
      dimensions: [
        {
          catalog_id: "farm.query.maps",
          entity_id: "place",
          member_id: "category",
        },
      ],
      filters: {
        and: [
          { member: "bbox_xmin", operator: "gte", value: 4.88 },
          { member: "bbox_xmax", operator: "lte", value: 4.91 },
          { member: "bbox_ymin", operator: "gte", value: 52.36 },
          { member: "bbox_ymax", operator: "lte", value: 52.38 },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.sql).toContain('_e0."bbox"."xmin" >= ?');
      expect(result.plan.sql).toContain('_e0."bbox"."ymax" <= ?');
      expect(result.plan.parameters).toEqual([4.88, 4.91, 52.36, 52.38]);
    }

    expect(resolveNestedType("STRUCT(xmin DOUBLE)", ["missing"])).toBeNull();
  });

  test("keeps dots in literal physical column names", () => {
    const dotted = catalog("runtime", "com.example.dotted", [
      {
        name: "events",
        entityId: "events",
        grain: ["id"],
        columns: ["id", "literal.dot"],
        requiredFilters: [["literal.dot"]],
        members: [
          { member_id: "id", kind: "identifier", column: "id" },
          {
            member_id: "literal_dot",
            kind: "dimension",
            column: "literal.dot",
          },
          {
            member_id: "event_count",
            kind: "measure",
            aggregation: "count_rows",
            additivity: "additive",
          },
        ],
      },
    ]);
    const result = compileSemanticQuery([dotted], {
      measures: [
        {
          catalog_id: "com.example.dotted",
          entity_id: "events",
          member_id: "event_count",
        },
      ],
      filters: { member: "literal_dot", operator: "eq", value: "yes" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.sql).toContain('_e0."literal.dot" = ?');
      expect(result.plan.sql).not.toContain('_e0."literal"."dot"');
    }
  });

  test("reads DuckDB 2.0 native member tags from table-function output columns", () => {
    const functions: CatalogData = {
      catalogName: "events_runtime",
      catalogComment: null,
      catalogTags: {
        "vgi.semantic_catalog": j({ catalog_id: "com.example.events" }),
      },
      defaultSchema: "main",
      schemas: [
        {
          info: { name: "main", comment: null, tags: {} } as any,
          tables: [],
          views: [],
          macros: [],
          functions: [
            {
              name: "events",
              schema_name: "main",
              function_type: "TABLE",
              _parameters: ["region"],
              _functionArgsDetailed: true,
              _functionArgs: [
                {
                  name: "region",
                  arrowType: "Utf8",
                  duckdbType: "VARCHAR",
                  nullable: true,
                  named: true,
                  positional: false,
                  fieldIndex: 0,
                  isTableInput: false,
                  isAnyType: false,
                  isVarargs: false,
                  isConst: false,
                  defaultValue: "all",
                },
              ],
              tags: {
                "vgi.semantic_entity": j({
                  entity_id: "events",
                  grain: ["event_id"],
                  source: {
                    arguments: [
                      {
                        argument: "region",
                        parameter: "region",
                        required: false,
                      },
                    ],
                  },
                }),
                "vgi.semantic_members": j([
                  {
                    member_id: "event_count",
                    kind: "measure",
                    aggregation: "count_rows",
                    additivity: "additive",
                  },
                ]),
              },
              _functionReturn: {
                isTable: true,
                columns: [
                  {
                    name: "event_id",
                    arrowType: "Int64",
                    duckdbType: "BIGINT",
                    nullable: false,
                    tags: {
                      "vgi.semantic_member": j({
                        kind: "identifier",
                        member_id: "event_id",
                      }),
                    },
                  },
                ],
              },
            } as any,
          ],
        },
      ],
    };
    const environment = buildSemanticEnvironment([functions]);
    expect(environment.diagnostics).toEqual([]);
    expect(environment.entities[0].sourceKind).toBe("table_function");
    expect(environment.entities[0].members.get("event_id")?.column).toBe(
      "event_id",
    );
    const compiled = compileSemanticQuery([functions], {
      measures: [
        {
          catalog_id: "com.example.events",
          entity_id: "events",
          member_id: "event_count",
        },
      ],
      compile_only: true,
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.plan.sql).toContain('"events"() AS _e0');
  });

  test("compiles a fixed-schema table macro as a scalar semantic source", () => {
    const historical: CatalogData = {
      catalogName: "maps_runtime",
      catalogComment: null,
      catalogTags: {
        "vgi.semantic_catalog": j({ catalog_id: "farm.query.maps" }),
      },
      defaultSchema: "gers",
      schemas: [
        {
          info: { name: "gers", comment: null, tags: {} } as any,
          tables: [],
          views: [],
          functions: [],
          macros: [
            {
              name: "changelog_at",
              schema_name: "gers",
              macro_type: "TABLE",
              parameters: ["release"],
              definition: "SELECT 1",
              tags: {
                "vgi.semantic_entity": j({
                  entity_id: "historical_changelog",
                  grain: ["id"],
                  source: {
                    arguments: [
                      {
                        argument: "release",
                        parameter: "release",
                        required: true,
                      },
                    ],
                  },
                }),
                "vgi.semantic_members": j([
                  { member_id: "id", kind: "identifier", column: "id" },
                  {
                    member_id: "record_count",
                    kind: "measure",
                    aggregation: "count_rows",
                    additivity: "additive",
                  },
                ]),
              },
              function_type: "table_macro",
              input_from_args: null,
              _parameters: ["release"],
              _parameterTypes: ["VARCHAR"],
              _functionArgsDetailed: true,
              _functionArgs: [fnArg("release", "VARCHAR", 0)],
              _functionReturn: {
                isTable: true,
                columns: [
                  {
                    name: "id",
                    arrowType: "VARCHAR",
                    duckdbType: "VARCHAR",
                    nullable: false,
                  },
                ],
              },
            } as any,
          ],
        },
      ],
    };
    const result = compileSemanticQuery([historical], {
      measures: [
        {
          catalog_id: "farm.query.maps",
          entity_id: "historical_changelog",
          member_id: "record_count",
        },
      ],
      parameters: { release: "2026-06-17.0" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.sql).toContain(
        'FROM "maps_runtime"."gers"."changelog_at"(?) AS _e0',
      );
      expect(result.plan.parameters).toEqual(["2026-06-17.0"]);
    }
  });

  test("infers positional and named source bindings from physical argument metadata", () => {
    const functions: CatalogData = {
      catalogName: "events_runtime",
      catalogComment: null,
      catalogTags: {
        "vgi.semantic_catalog": j({ catalog_id: "com.example.events" }),
      },
      defaultSchema: "main",
      schemas: [
        {
          info: { name: "main", comment: null, tags: {} } as any,
          tables: [],
          views: [],
          macros: [],
          functions: [
            {
              name: "events",
              schema_name: "main",
              function_type: "TABLE",
              _parameters: ["since", "region"],
              _functionArgsDetailed: true,
              _functionArgs: [
                {
                  name: "since",
                  arrowType: "Timestamp",
                  duckdbType: "TIMESTAMP",
                  nullable: false,
                  named: false,
                  positional: true,
                  position: 0,
                  fieldIndex: 0,
                  isTableInput: false,
                  isAnyType: false,
                  isVarargs: false,
                  isConst: false,
                },
                {
                  name: "region",
                  arrowType: "Utf8",
                  duckdbType: "VARCHAR",
                  nullable: true,
                  named: true,
                  positional: false,
                  fieldIndex: 1,
                  isTableInput: false,
                  isAnyType: false,
                  isVarargs: false,
                  isConst: false,
                  defaultValue: "all",
                },
              ],
              tags: {
                "vgi.semantic_entity": j({
                  entity_id: "events",
                  grain: ["event_id"],
                  source: {
                    arguments: [
                      {
                        argument: "region",
                        parameter: "region",
                        required: false,
                      },
                      { argument: "since", parameter: "start" },
                    ],
                  },
                }),
                "vgi.semantic_members": j([
                  {
                    member_id: "event_id",
                    kind: "identifier",
                    column: "event_id",
                  },
                  {
                    member_id: "event_count",
                    kind: "measure",
                    aggregation: "count_rows",
                    additivity: "additive",
                  },
                ]),
              },
              _functionReturn: {
                isTable: true,
                columns: [
                  {
                    name: "event_id",
                    arrowType: "Int64",
                    duckdbType: "BIGINT",
                    nullable: false,
                  },
                ],
              },
            } as any,
          ],
        },
      ],
    };
    const compiled = compileSemanticQuery([functions], {
      measures: [
        {
          catalog_id: "com.example.events",
          entity_id: "events",
          member_id: "event_count",
        },
      ],
      parameters: { start: "2026-01-01", region: "US" },
      compile_only: true,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.plan.sql).toContain(
      'FROM "events_runtime"."main"."events"(?, "region" := ?) AS _e0',
    );
    expect(compiled.plan.parameters).toEqual(["2026-01-01", "US"]);

    const functionInfo = functions.schemas[0].functions[0] as any;
    functionInfo._parameters = ["since", "until"];
    functionInfo._functionArgs = [
      { ...functionInfo._functionArgs[0], name: "since", defaultValue: "0" },
      {
        ...functionInfo._functionArgs[0],
        name: "until",
        position: 1,
        fieldIndex: 1,
      },
    ];
    functionInfo.tags["vgi.semantic_entity"] = j({
      entity_id: "events",
      grain: ["event_id"],
      source: {
        arguments: [
          { argument: "since", parameter: "since", required: false },
          { argument: "until", parameter: "until" },
        ],
      },
    });
    const hole = compileSemanticQuery([functions], {
      root_entity: { catalog_id: "com.example.events", entity_id: "events" },
      dimensions: [
        {
          catalog_id: "com.example.events",
          entity_id: "events",
          member_id: "event_id",
        },
      ],
      parameters: { until: "2026-12-31" },
      compile_only: true,
    });
    expect(hole.ok).toBe(false);
    if (!hole.ok)
      expect(
        hole.diagnostics.some(
          (diagnostic) => diagnostic.code === "optional_positional_hole",
        ),
      ).toBe(true);

    functionInfo._functionArgs = [
      {
        ...functionInfo._functionArgs[0],
        isVarargs: true,
        positional: false,
        position: undefined,
      },
    ];
    const varargs = buildSemanticEnvironment([functions]);
    expect(
      varargs.diagnostics.some(
        (diagnostic) => diagnostic.code === "unsupported_function_varargs",
      ),
    ).toBe(true);

    functionInfo._functionArgsDetailed = false;
    const missingMetadata = buildSemanticEnvironment([functions]);
    expect(
      missingMetadata.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "missing_function_argument_metadata",
      ),
    ).toBe(true);
    functionInfo._functionArgsDetailed = true;

    functions.schemas[0].functions.push({ ...functionInfo } as any);
    const overloaded = buildSemanticEnvironment([functions]);
    expect(
      overloaded.diagnostics.some(
        (diagnostic) => diagnostic.code === "ambiguous_function_overload",
      ),
    ).toBe(true);
  });

  test("compares packed and native member objects independent of JSON key order", () => {
    const worker = sales();
    (worker.schemas[0].tables[0] as any)._columnInfo[0].tags = {
      "vgi.semantic_member": j({
        column: "order_id",
        kind: "identifier",
        member_id: "order_id",
      }),
    };
    const environment = buildSemanticEnvironment([worker]);
    expect(
      environment.diagnostics.some(
        (item) => item.code === "member_carrier_conflict",
      ),
    ).toBe(false);
  });
});
