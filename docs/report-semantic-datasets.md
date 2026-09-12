# Governed report authoring

Governed report datasets let a report author ask for business measures and dimensions while keeping
the join, aggregation, fanout, required-filter, type, unit, and execution-limit rules in the
attached VGI semantic model. They are useful alongside ordinary SQL datasets: authors can choose a
governed source when the model covers the question and use SQL for unmodeled analysis.

## Author workflow

1. Open a report and select **Datasets**.
2. Choose **Add governed dataset**.
3. Search for one or more measures, then choose dimensions under **Break down by**.
4. Select a time grain where applicable.
5. Supply table-function parameters, or bind them to report controls. A blank value uses the
   physical argument default discovered from the worker.
6. Add filters, sort fields, and a maximum row count.
7. Choose **Test query**. Cupola compiles the semantic request and runs the generated SQL with
   positional prepared values.
8. Choose **Apply and refresh**. The tested result is reused, avoiding a duplicate provider call.

The builder deliberately covers the common single- and multi-measure workflow. Use **Advanced
semantic JSON** for correlated inline inputs, entity-driven LATERAL pipelines, explicit
relationship paths, multi-fact requests, or derived measures. Invalid advanced JSON is never
executed.

## Persisted contract

Reports retain schema version 1. Legacy SQL datasets remain valid and may omit `kind`:

```json
{
  "id": "orders",
  "name": "Orders",
  "sql": "SELECT * FROM orders WHERE country = $country"
}
```

A governed dataset has `kind: "semantic"`, a `query`, and no `sql` property:

```json
{
  "id": "revenue",
  "name": "Revenue by day",
  "kind": "semantic",
  "query": {
    "measures": [{
      "catalog_id": "com.example.sales",
      "entity_id": "orders",
      "member_id": "revenue"
    }],
    "dimensions": [{
      "catalog_id": "com.example.sales",
      "entity_id": "orders",
      "member_id": "ordered_at",
      "granularity": "day"
    }],
    "filters": {
      "member": {
        "catalog_id": "com.example.sales",
        "entity_id": "orders",
        "member_id": "country"
      },
      "operator": "eq",
      "value": { "report_parameter": "country" }
    },
    "order": [{ "member": "ordered_at", "direction": "asc" }],
    "limit": 1000
  }
}
```

`acceptedModelFingerprint` is optional. Cupola establishes it after a successful test-and-apply or
when a new governed dataset is first published. It is a review baseline, not a compiler version and
not an execution lock.

## Report controls

Use `{ "report_parameter": "key" }` in place of a scalar semantic value. Cupola resolves the
marker from the report's currently applied controls before compilation. A date-range control must
choose an endpoint:

```json
{
  "filters": {
    "and": [
      {
        "member": {
          "catalog_id": "com.example.sales",
          "entity_id": "orders",
          "member_id": "ordered_at"
        },
        "operator": "gte",
        "value": { "report_parameter": "period", "part": "start" }
      },
      {
        "member": {
          "catalog_id": "com.example.sales",
          "entity_id": "orders",
          "member_id": "ordered_at"
        },
        "operator": "lte",
        "value": { "report_parameter": "period", "part": "end" }
      }
    ]
  }
}
```

Only `report_parameter` and optional `part` are recognized in this marker. Cupola does not evaluate
expressions or accept embedded SQL.

## Refresh and review behavior

- Every run recompiles the saved intent against the attached catalogs.
- Only parameterized SQL returned by the semantic compiler is executed.
- Expected semantic failures remain structured compiler diagnostics; there is no silent SQL
  fallback.
- Units come from `plan.output_units` and do not alter the SQL result.
- A changed model fingerprint raises a visible warning after a successful compile. The current
  result is still shown so readers are not surprised by a blank report.
- Authors accept the current model from the dataset details page after reviewing generated SQL,
  grain, sources, units, warnings, and result shape.
- Reattaching the same stable catalog/entity model under another alias does not itself cause drift.

Publishing validates and refreshes the report using parameter defaults. Any new governed dataset
without a baseline receives one only after that validation succeeds.

## AI behavior

An Ask AI semantic result has **Add to report**, which copies the original tool request into a
governed dataset. The report agent uses the same dataset contract.

The default AI policy is `unrestricted-sql`, so existing users retain SQL tools. Under
`semantic-preferred`, agents are instructed to use governed concepts first. Under `semantic-only`,
report AI can author and revise governed datasets but cannot create SQL datasets, preview arbitrary
SQL, or attach new blocks to an existing SQL dataset. Humans may still inspect and edit reports;
the policy controls AI-issued database access.
