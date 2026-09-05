# Semantic model integration

Cupola consumes the VGI semantic tag contract vendored from `vgi-lint-check`. Run
`VGI_LINT_REPO=../vgi-lint-check bun run tags:sync` after changing the upstream contract;
`tags:check` verifies both the contract and semantic-schema hashes.

`semantic-model.ts` normalizes packed DuckDB 1.5 members and native column tags, resolves stable
catalog/entity identities across arbitrary attachment aliases, reconciles reciprocal and third-party
relationships, and keeps relationship resolution separate from attestation.

`semantic-compiler.ts` is the shared, pure compiler. It accepts one root measure grain, typed
dimensions/filters, explicit relationship paths, runtime bindings, typed query-local row sets and
bounded correlated table-function pipelines. It rejects multi-root measures, traversal into a many
side, unsafe casts, ambiguous bindings and invalid invocation dataflow. Its deterministic plan always
contains one `fact_branches` element and positional parameters.

For a parameterized table-function source, the semantic tag maps physical argument names to stable
semantic parameter names only. The compiler resolves calling convention from
`vgi_function_arguments()`: positional arguments are emitted as `?` in `arg_position` order, then
named arguments as `"name" := ?` in `field_index` order. The catalog loader retains both ordinals and
keeps argument rows scoped by function type. Compilation fails when detailed metadata is missing,
an overload or mapping is ambiguous, the function uses varargs/table input, or supplying a later
positional value would create an optional hole. The compiler never guesses from DuckDB's flattened
parameter list.

The catalog loader also retains the function-level `input_from_args` capability repeated by
`vgi_function_arguments()`. `defineRowTransformFunction()` supplies it through `FunctionInfo`; it is
not a semantic tag. `describe_function` exposes both `input_from_args` and the derived
`supports_correlated_input` label to agents.

`inputs` supplies a bounded typed `VALUES` row set with a declared grain. `source_bindings` binds one
table-function entity to an inline input or semantic entity driver. An argument binding is a scalar
`parameter`, an `input_column`, or a fully qualified driver `member`. Column/member bindings require
`input_from_args`, a positional non-constant argument, and a compatible known type.

Bindings form an acyclic path to the fact root and may chain functions, for example locations →
geocoding → weather. The compiler emits bounded CTE stages with nested driver/entity structs so
provenance remains unambiguous. These are invocation/dataflow edges, never semantic relationships.
Dimensions from any entity on the selected invocation path remain directly selectable without a
relationship. The plan exposes invocation order and bindings, estimated invocations, effective
source grain, result grain and explicit grain reduction. Upstream grain is automatically projected
and grouped unless `allow_driving_grain_reduction` is true.

Inline inputs allow at most 100 rows, 32 columns, 3,200 cells and one megabyte of rows. Entity
drivers require `max_rows`; each stage has `max_output_rows` (default 10,000). The request-level
`execution_limits.max_invocations` defaults to 100 and cannot exceed 1,000. This bounds correlated
input rows, not provider HTTP calls.

Entity-driver `filters` and member `order` compile inside the driver subquery before its `max_rows`
and lateral invocation. Required filters declared by a driver must be satisfied there; a top-level
filter after expansion does not prevent unwanted provider calls and therefore does not count.

`query_semantic_model` is exposed in Ask AI, shell AI, editor AI and report authoring. The shared
executor compiles first and uses `engine.queryPrepared` plus the normal conversation result cache.
`compile_only` returns before consulting either bridge, which guarantees semantic-only validation
does not prepare, bind, explain, execute or cache SQL. Failures are returned as structured
diagnostics; callers must not fall back to `run_sql` automatically.

Reports remain SQL-backed. A report agent may use compile-only output as a dataset query, but once a
user edits or persists that SQL it no longer carries compiler provenance.
