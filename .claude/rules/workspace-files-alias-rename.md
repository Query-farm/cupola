---
paths:
  - "src/lib/workspace/**"
  - "src/components/workspace/**"
  - "src/lib/command-palette.ts"
  - "src/components/CommandPalette.tsx"
  - "src/lib/evidence/report-requires.ts"
  - "public/schema/**"
  - "tests/workspace-files.spec.ts"
  - "tests/alias-rename.spec.ts"
  - "tests/report-requires.spec.ts"
  - "tests/command-palette.spec.ts"
  - "tests/unit/workspace-*.test.ts"
---

# Workspace files, scripts, alias rename, `requires`, ⌘K

## Files (`workspace/file.ts`)
- `#ws=` JSON + unversioned `$schema` (`https://cupola.query-farm.services/schema/workspace-v1.json` — the Worker serves unversioned paths from the latest release), validated by `validateWorkspaceFile`.
- Export: portable record only, no secret values or overlay. Secret **names** ride as `secrets: [...]`; the validator drops options named there and credential-looking names. Pending `rawOptions` and unnamed catalogs omitted with a note; disabled catalogs exported (enabled is personal).
- `planImport` by id: new / identical / conflict (ignores catalog ids, colours, secrets; pending expressions always conflict). **Replace** keeps the id and secrets only where catalog id + URL + server name are unchanged, so a file can't repoint a catalog and inherit its credential. **Keep both** → new id, "(imported)".
- Imports get `lastOpenedAt: 0` (never "the last named workspace"); untitled imports are named after their catalogs (not pruned or fingerprint-merged). `secretsNeeded` lists empty secrets.
- Trap: secret names aren't stored, so re-exporting before entering them loses them.
- `tests/workspace-files.spec.ts` needs no VGI worker.

## Scripts (`workspace/duckdb-script.ts`)
- Export via `buildAttachSql(..., "cli")`; secrets get a synthesized `secret: true` spec so `pin` still becomes `getenv()`. `-- Workspace id:` header (flattened to one line) makes round-trips byte-stable.
- Import: closed set (ATTACH vgi|grainlift, `USE a[.s]`, INSTALL/LOAD vgi|grainlift), all-or-nothing, line-numbered; SET/PRAGMA/everything else refused. Real tokenizer; `$$` strings, unknown chars and `;` inside open brackets refused.
- Values via `splitLegacyOptions` / `parsePlainLiteral`: literals → values; other constants → `rawOptions` (engine allowlist at connect). Whole-value `getenv('X')` → empty secret; literal credentials not imported (warning); `bearer_token` / `oauth_refresh_token` skipped. Grainlift needs `target`.

## JSON Schema (`public/schema/workspace-v1.json`)
- `tests/unit/workspace-schema.test.ts` checks it against the validator (hand-rolled checker; fails on unknown keywords). Patterns are the validator's regexes, case-folded (no `i` flag).
- Refuses what the validator refuses or only repairs; allows unknown keys; refuses surrounding whitespace.

## Alias rewriting (`workspace/alias-rewrite.ts`)
- Tokenizer, not regex or `json_serialize_sql` (reformats text, needs the engine). Skips strings, comments, `$param`s, `${query}`.
- Reference = 3+ parts from the alias, 2 parts only in relation position, bare after `USE`/`DETACH`. `SELECT sales.amount FROM orders AS sales` unchanged.
- Matching is case-insensitive, quoted identifiers included (DuckDB folds both); a rewrite keeps each reference's quoting and quotes the new alias only when `needsQuoting`.
- `rewriteAliases` maps in one pass (swaps work). Gap: `t.struct_col.field` is read as a catalog reference.
- Reports (`report-requires.ts`): SQL fences, setup SQL, choices queries only.

## Rename flow (`workspace/alias-rename.ts`)
- Trap: the open editor and report rewrite themselves via synchronous window events, or their autosave undoes a storage write.
- Entry: `onAliasRenameRequested` (`workspace/events.ts`) → `AliasRenameHost`. The open report saves unsaved edits as their own revision first. Other reports: `saveReportWithRevision`. Other tabs: `readEditorState`, never `loadEditorState` (which migrates). Then `CatalogApp.renameAlias` updates the store and re-attaches (DuckDB can't rename), keeping default. Drafts and AI chats aren't rewritten.

## Report `requires`
- `[{alias, url, catalogName}]`, qualified references only. Derived in `EvidenceWorkspace.persist` (`withDerivedRequires`), **not** `saveEvidenceReport`: import and Copy to workspace keep the source's. Not a revision field. Additive, files stay v2; malformed list dropped.
- `resolveRequires`: same catalog + alias = fine; same catalog, other alias = **Rebind**; other catalog, same alias = accepted; else **Attach X…** or **Open anyway**.

## ⌘K palette (`lib/command-palette.ts`)
- Never with Shift (CodeMirror) or Alt; `window` capture listener. Not inside `.xterm`, where ⌘K/Ctrl+K clears the terminal.
