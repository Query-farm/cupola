---
paths:
  - "src/lib/evidence/**"
  - "src/components/evidence/**"
  - "src/lib/reports/**"
  - "tests/evidence*.spec.ts"
  - "tests/fixtures/evidence-*"
---

# Evidence reports: metadata, agent, parameters, files, revisions, autosave

## Table metadata (`catalog-metadata.svelte.ts`, `catalog-names.ts`)
- `CupolaMetadata` overrides `load()`/`getTable()`: tables registered once as `catalog.schema.table` (several catalogs attach at once). Short names resolve in DuckDB's order: bare → temp, then default db's schema; `x.table` → schema `x` of searched catalogs, then catalog `x`'s `main`. The metadata never names a table DuckDB wouldn't reach with the same reference.
- Introspection goes straight to the engine (`readRowsOrThrow`), not the report's query service, so stopping a report doesn't cancel it.

## Report agent
- `test_setup_sql` (`setup-test.ts`, `engine.rolledBack`): runs statements in one transaction, always rolled back,. Refused up front: `SET`/`PRAGMA`/`INSTALL`/`LOAD`/`USE` (SET doesn't roll back), non-TEMP `CREATE` outside `temp`/`memory`, writes to anything but session temp tables. `ROLLBACK` sits in `finally` and ignores "no transaction is active".
- `run_sql` is read-only (`isReadOnlySql`).
- `get_report.lastRefresh.byQuery` (`refreshForAgent`) backs the prompt rule: a small remote source feeding several components goes in setup SQL as one `CREATE OR REPLACE TEMP TABLE`.
- `propose_report_edit` (`agent.ts`, `source-check.ts`): `sourceEdits`/`setupSqlEdits` are exact find/replace (each `old_text` exactly once, in order) resolved to a full `after`. Evidence `parse` + `validate` (no render context) plus unclosed-`{%` check; new errors refused. Errors matched by message, not line. Validator needs `import.meta.glob`, so it can't run under `bun test`.
- Queries cancelled by a stopped/superseded refresh return their error but aren't logged (`HaybarnQueryService.execute`).

## Parameters (`parameters.ts`, `parameter-graph.ts`, `parameter-choices.ts`, `parameter-url.ts`, `parameter-lint.ts`, `drill.ts`, `filter-summary.ts`)
- Binding (`compileReportQuery`, `src/lib/reports/parameters.ts`): multi-select → `?, ?, …`; date range → `$key_start`/`$key_end`; `$key_all` TRUE for All/unset — idiom `($key_all OR col IN ($key))`, never `$key IS NULL`.
- Dependencies are inferred from `$refs` in choices queries; `parameterGraphErrors` rejects unknown, self and cyclic refs. `resolveChoices` runs parents first with *fitted* values; `reconcileValue` resets a vanished value per `defaultMode`, noting the label from the *previous* choices. **Refresh runs the same resolver before binding.** Choices are cached by SQL + bound values, so a parent change re-runs only its children.
- Only explicit values that stop being choices are written back (so `defaultMode: "first"` doesn't dirty a report).
- URL state is `p.<key>`, only values differing from initial. Back/Forward via `completeValuesFromUrl`; an opened link's values are the saved baseline.
- Bridge: each param except date ranges registered as an Evidence `ExternalFilter` via `setDefault` (never assignment: it writes the URL). Param named like an input id = lint error.
- Drilldown: `drillPaths` is report data (tag schemas reject unknown attributes). Matches next unset level by label then value; matching cells `role="button"` + focusable. Drill pushes history. Never use Evidence's row `link` (`window.open(url, "_self")` navigates the tab away).
- PDF Filters (`summarizeFilters`): drill path, params by label, page inputs, filter inputs classified `filter`. PDF per value (`createPdfExport`/`addSection`) needs a file prefix per section.
- Refresh/Stop: lazy renderer queries show Stop only after 400ms (else misclicks on a reused node). `refresh()` with no arg reads `reportRef`, updated synchronously in `change()` (CodeMirror edits are outside React events).
- Tests: `tests/evidence-parameters.spec.ts`, `tests/evidence-drill.spec.ts` on the test service's `geo` schema (`tests/fixtures/evidence-geo-report.ts`). Use `replaceEditorText` (helpers.ts), not `fill()`, for long CodeMirror text.

## Refresh display (`EvidenceWorkspace.tsx`, `EvidenceRefreshStatus.tsx`, `report-changes.ts`)
- One experience for every trigger: the previous render stays up as a static copy (`retained`, dimmed after 300ms by `.report-dim-while-refreshing`), the new run's `EvidencePreview` mounts `invisible` behind it, and `reveal()` swaps them once the run has mounted, its queries are quiet for 700ms and no chart is `data-echarts-ready="false"` — or after `REVEAL_TIMEOUT_MS` (8s). Keep the preview at the same tree position across the swap, or it remounts and re-queries.
- Live semantic temp tables are dropped before render, so the old document can't stay live; the static copy covers the gap. A refresh starting from a run with errors falls back to `lastGood`. Stop during a hidden render drops the new run. `settledRoot()` (PDF) waits for the reveal.
- Status: header pill (verb from `refresh(next, history, action)`, phase, elapsed; opens the checklist), a 2px bar and a bottom chip (after `CHIP_DELAY_MS`) positioned in the preview pane outside its scroller, so they show at any scroll depth. A failure/stop while scrolled past the report's notice repeats in the chip.
- After a structural change (`diagnosticSpec` differs) `markReportChanges` diffs the copy's blocks against the new ones (text + 8×8 canvas print) and outlines them (`data-cupola-change`, styles in `evidence.css`). `onApplyPreview` resolves with the list after the reveal; the agent card links each part (`showReportChange`).

## Report files (`report-file.ts`)
- Import accepts the file, a bare report or an array; each report validates alone and saves into the current scope. Same id + same content (timestamps/service ignored) → skip; else replace or keep both as "(imported)".

## Revisions (`revisions.ts`, History tab)
- Key `cupola.evidence.history.v1:`, deleted with the report; carried in report files (version 2; v1 still imports).
- Values stored once by content hash in `blobs`; imports union histories (a removed revision returns if an older file is imported).
- Agent proposals (`onProposal`) save at once labelled with the summary; reader edits before Apply are saved first as their own revision.
- `removeRevision` (never the latest): recompute next revision's `changed`, regenerate labels naming only those fields, drop unused blobs.

## Autosave (`persist` / `autosave` in `EvidenceWorkspace.tsx`)
- Saves `AUTOSAVE_DELAY_MS` after the last edit and immediately on `visibilitychange` hidden, `pagehide`, `beforeunload`. No Save button; ⌘S handled (closes the session revision), not advertised. Known gap: two tabs editing one report overwrite each other (last save wins).
- `recordRevision` grows the session's latest revision within `SESSION_WINDOW_MS`; page load, ⌘S, agent proposal, undo, restore start a new session.
- New report saves on first edit, except **Add to report** (`openReport(..., saveNow)`). Id is in the URL from the start (`listUnsavedDrafts`).
- Param-`values`-only saves add no revision. Blank title saves as "Untitled report" (`titled()`); dirtiness compares `asSaved(report)`.
- Invalid draft → raw in `cupola.evidence.draft.v1:`, loaded with a notice next open.
- Storage full: `shrinkStoredHistory` then retry; `saveReportHistory` drops oldest and returns the count.
- Autosave pauses during PDF-per-value. Opening another report saves first.

## Performance tab (`refresh-profile.ts`, `EvidencePerformance.tsx`)
- `RefreshProfiler` on one `performance.now()` clock; component queries named via `nameRenderQueries`.
- Rendering ends when the document has mounted **and** queries are quiet for 700ms.
- A choices load is "cached" only if it had already finished.
- Open in Query Editor fills `$parameters` with the refresh's values (`materializeReportQuery`).
