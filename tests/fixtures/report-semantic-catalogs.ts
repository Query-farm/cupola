import type { CatalogData } from "../../src/lib/service";

export const salesRef = {
  catalog_id: "com.example.sales",
  entity_id: "orders",
};
export const customersRef = {
  catalog_id: "com.example.crm",
  entity_id: "customers",
};
export const forecastRef = {
  catalog_id: "com.example.weather",
  entity_id: "forecast",
};
export const customerRelationship = {
  relationship_id: "com.example.order_customer",
  from: salesRef,
  to: customersRef,
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

function tableCatalog(
  ref: typeof salesRef,
  members: any[],
  relationships: any[] = [],
): CatalogData {
  return {
    catalogName: ref.catalog_id.split(".").at(-1)!,
    catalogComment: null,
    defaultSchema: "main",
    catalogTags: {
      "vgi.semantic_catalog": JSON.stringify({ catalog_id: ref.catalog_id }),
    },
    schemas: [
      {
        info: { name: "main", comment: null, tags: {} } as any,
        views: [],
        macros: [],
        functions: [],
        tables: [
          {
            name: ref.entity_id,
            schema_name: "main",
            comment: null,
            required_filters: [],
            tags: {
              "vgi.semantic_entity": JSON.stringify({
                entity_id: ref.entity_id,
                grain: [members[0].member_id],
              }),
              "vgi.semantic_members": JSON.stringify(members),
              "vgi.semantic_relationships": JSON.stringify(relationships),
            },
            _columnInfo: members
              .filter((member) => member.column)
              .map((member) => ({
                name: member.column,
                duckdbType: member.data_type ?? "VARCHAR",
                arrowType: member.data_type ?? "VARCHAR",
                nullable: false,
              })),
          } as any,
        ],
      },
    ],
  };
}

export function reportSemanticCatalogs(): CatalogData[] {
  return [
    tableCatalog(
      salesRef,
      [
        {
          member_id: "order_id",
          kind: "identifier",
          column: "order_id",
          data_type: "VARCHAR",
        },
        {
          member_id: "customer_id",
          kind: "dimension",
          column: "customer_id",
          data_type: "VARCHAR",
          conformance_id: "customer",
        },
        {
          member_id: "ordered_at",
          kind: "time_dimension",
          column: "ordered_at",
          data_type: "DATE",
          timezone: "UTC",
          granularities: ["day", "month", "year"],
        },
        {
          member_id: "amount",
          kind: "dimension",
          column: "amount",
          data_type: "DOUBLE",
          unit: "USD",
          hidden: true,
        },
        {
          member_id: "revenue",
          kind: "measure",
          title: "Net revenue",
          description: "Revenue after discounts.",
          aggregation: "sum",
          member: "amount",
          output_type: "DOUBLE",
          unit: "USD",
          additivity: "additive",
        },
      ],
      [customerRelationship],
    ),
    tableCatalog(customersRef, [
      {
        member_id: "customer_id",
        kind: "identifier",
        column: "customer_id",
        data_type: "VARCHAR",
        conformance_id: "customer",
      },
      {
        member_id: "country",
        kind: "dimension",
        title: "Country",
        column: "country",
        data_type: "VARCHAR",
      },
      {
        member_id: "customer_count",
        kind: "measure",
        title: "Customers",
        aggregation: "count_rows",
        output_type: "BIGINT",
        additivity: "additive",
      },
    ]),
  ];
}

export function reportFunctionCatalog(): CatalogData {
  return {
    catalogName: "weather",
    catalogComment: null,
    defaultSchema: "main",
    catalogTags: {
      "vgi.semantic_catalog": JSON.stringify({
        catalog_id: forecastRef.catalog_id,
      }),
    },
    schemas: [
      {
        info: { name: "main", comment: null, tags: {} } as any,
        tables: [],
        views: [],
        macros: [],
        functions: [
          {
            name: "forecast",
            schema_name: "main",
            function_type: "TABLE",
            input_from_args: true,
            _functionArgsDetailed: true,
            _functionArgs: [
              {
                name: "city",
                arrowType: "VARCHAR",
                duckdbType: "VARCHAR",
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
            ],
            _functionReturn: {
              isTable: true,
              columns: [
                {
                  name: "city",
                  arrowType: "VARCHAR",
                  duckdbType: "VARCHAR",
                  nullable: false,
                },
                {
                  name: "day",
                  arrowType: "DATE",
                  duckdbType: "DATE",
                  nullable: false,
                },
                {
                  name: "temperature",
                  arrowType: "DOUBLE",
                  duckdbType: "DOUBLE",
                  nullable: false,
                },
              ],
            },
            tags: {
              "vgi.semantic_entity": JSON.stringify({
                entity_id: "forecast",
                grain: ["day"],
                source: {
                  arguments: [{ argument: "city", parameter: "city" }],
                },
              }),
              "vgi.semantic_members": JSON.stringify([
                {
                  member_id: "day",
                  kind: "identifier",
                  column: "day",
                  data_type: "DATE",
                },
                {
                  member_id: "city",
                  kind: "dimension",
                  column: "city",
                  data_type: "VARCHAR",
                },
                {
                  member_id: "temperature",
                  kind: "dimension",
                  column: "temperature",
                  data_type: "DOUBLE",
                  unit: "Cel",
                  hidden: true,
                },
                {
                  member_id: "average_temperature",
                  kind: "measure",
                  title: "Average temperature",
                  aggregation: "avg",
                  member: "temperature",
                  output_type: "DOUBLE",
                  additivity: "non_additive",
                },
              ]),
            },
          } as any,
        ],
      },
    ],
  };
}

export function reportPipelineCatalogs(): CatalogData[] {
  const first = reportFunctionCatalog();
  const second = structuredClone(first);
  second.catalogName = "outlook";
  second.catalogTags["vgi.semantic_catalog"] = JSON.stringify({
    catalog_id: "com.example.outlook",
  });
  const fn = second.schemas[0].functions[0];
  fn.name = "outlook";
  const entity = JSON.parse(fn.tags["vgi.semantic_entity"]);
  fn.tags["vgi.semantic_entity"] = JSON.stringify({
    ...entity,
    entity_id: "outlook",
  });
  return [first, second];
}
