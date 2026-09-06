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

`column` is one literal physical column identifier, including when its name contains a dot. Nested
DuckDB `STRUCT` access uses an explicit `column_path` such as `["bbox", "xmin"]`. The model builder
validates the full path when detailed type discovery is available, and the compiler quotes every
path segment independently (`"bbox"."xmin"`). This also lets a nested member satisfy a matching
source-local required filter without introducing a raw-SQL expression escape hatch.

Packed member arrays may also contain bounded member templates. A template shallow-merges common
fields into concrete entries, validates every expansion against the ordinary member schema, and
exposes only the resulting concrete members to the environment and compiler. Templates do not nest,
interpolate strings, or execute code, and one packed carrier may expand to at most 500 members.
Native column tags remain concrete one-member declarations.

Relationship predicates are typed. In addition to backward-compatible equality, the compiler
supports `spatial_contains`, `spatial_within`, `spatial_intersects`, and repeated-field
`list_contains` with an explicitly identified collection-side element path. Optional discriminator
conditions compare a physical member to a model-owned scalar through a positional parameter. These
forms still use the normal single-fact cardinality checks; richer predicate syntax never permits
traversal into a `many` endpoint and never accepts raw SQL.

For a parameterized table-function source, the semantic tag maps physical argument names to stable
semantic parameter names only. The compiler resolves calling convention from
`vgi_function_arguments()`: positional arguments are emitted as `?` in `arg_position` order, then
named arguments as `"name" := ?` in `field_index` order. The catalog loader retains both ordinals and
keeps argument rows scoped by function type. Compilation fails when detailed metadata is missing,
an overload or mapping is ambiguous, the function uses varargs/table input, or supplying a later
positional value would create an optional hole. The compiler never guesses from DuckDB's flattened
parameter list.

A dimension or time dimension may use `source_argument` when useful invocation context is not
returned as a physical result column. The argument must be mapped exactly once and the member must
declare a compatible type. Scalar compilation projects the explicit semantic parameter or physical
default as a typed placeholder; correlated compilation projects the actual bound input column or
driver member. The resulting value can be selected, grouped, filtered, or referenced by typed
expressions without changing the function's physical result schema.

The catalog loader also retains the function-level `input_from_args` capability repeated by
`vgi_function_arguments()`. `defineRowTransformFunction()` supplies it through `FunctionInfo`; it is
not a semantic tag. The value is deliberately tri-state: `true` permits correlated column input,
`false` means the runtime explicitly does not support it, and `null` means the installed extension
does not expose capability discovery. Scalar calls remain valid for all three states, while a
correlated call with `null` returns an actionable upgrade diagnostic instead of being misreported as
explicitly unsupported. `describe_function` preserves that tri-state value in both
`input_from_args` and `supports_correlated_input` for agents.

Dimensions and measures may declare either a static physical `unit` or a parameter-dependent
`unit_parameter`; the two forms are mutually exclusive. Dynamic units map the effective value of a
semantic source argument to a unit string. The model builder verifies that the argument is unique,
is exposed by the entity's source-argument mapping, and covers every advertised argument choice.
UCUM strings are recommended where a suitable code exists, but the contract intentionally accepts
any non-empty unit string.

The compiler reports selected-column units in `plan.output_units` without changing SQL. A dynamic
unit uses an explicit scalar parameter value first and the physical argument default second. A
column- or member-bound correlated value is row-dependent, so it is always reported as `null` with
a `unit_parameter_value_unresolved` warning—even when the physical argument declares a default.
The compiler safely carries a source member's unit through `sum`, `min`, `max`, and `avg`; it does
not infer units through other derived arithmetic. Warnings appear in `plan.unit_diagnostics`.

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
