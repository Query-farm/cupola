---
paths:
  - "src/lib/attach/**"
  - "src/components/AttachOptions.tsx"
  - "src/lib/sentry-scrub.ts"
  - "tests/attach-options.spec.ts"
  - "tests/unit/attach*.test.ts"
  - "tests/fixtures/attach-option-asts.json"
---

# Structured ATTACH options (`src/lib/attach/`)

- Stored as name → DuckDB text, emitted `name 'text'` via `quoteLiteral`; names `^[A-Za-z_][A-Za-z0-9_]*$`.
- `buildAttachSql(spec, mode)` is the only builder: `execute`, `redacted` (`'***'`), `cli` (secrets as `getenv('<ALIAS>_<OPTION>')`).
- Legacy text is **never spliced**: `legacy-options.ts` checks the AST of the exact statement run, `SELECT CAST((<expr>) AS VARCHAR)`, against a constant allowlist (CONSTANT, CAST, unary minus, `list_value`/`struct_pack`/`map`/`row`). Unbalanced quotes/brackets refuse the whole text. Without the json extension only plain literals pass. Fixture: `tests/fixtures/attach-option-asts.json` (`bun scripts/attach-option-asts.ts`).
- Specs from `client.catalogsInfo()` (vgi ≥ 0.37.1). `prepare.ts` checks required options, then `TRY_CAST` per declared option via `arrowTypeToDuckDBCast` (the display form `STRUCT<{…}>` isn't SQL); a failure opens the error panel. Undeclared options go to the extension, which refuses unknown ones. Missing required option → `OptionsRequiredScreen`.
- Secrets (`spec.secret` or credential-like name) live only in `cupola.catalog-secrets.v1` (`workspaceId:catalogId:option`; old URL + catalog name + option keys are a read-only fallback); never in records, links, logs or Sentry. `sentry-scrub.ts` scrubs registered values and `<credential> '…'` literals.
- `fetchCatalog` skips the RPC tree when options are set (`catalog_attach` carries none); the tree comes from DuckDB.
- Error-panel probe is a GET: vgi-rpc answers HEAD with 405.
