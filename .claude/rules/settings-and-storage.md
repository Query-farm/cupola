---
paths:
  - "src/lib/settings.tsx"
  - "src/components/SettingsModal.tsx"
  - "src/lib/ai/model-*.ts"
  - "src/lib/pricing.ts"
  - "src/lib/workspace/store.ts"
  - "tests/settings.spec.ts"
---

# Settings and storage keys

## Settings (localStorage `vgi-frontend-settings`; never rename: users lose settings)

| Setting | Default | Notes |
|---------|---------|-------|
| `showDuckDBTypes` | `true` | DuckDB type names instead of Arrow |
| `hideTableBackingFunctions` | `true` | |
| `hideDollarTables` | `true` | names containing `$` |
| `shellFontSize` | `13` | |
| `shellThreads` | `0` | 0 = auto |
| `previewRowsPerPage` | `50` | one of DataPreview's `PAGE_SIZES` |
| `previewLayout` | `"grid"` | `grid` or `lines` (`DataRecords.tsx`) |
| `geometryAsText` | `false` | WKT instead of `GeometryViewer` |
| `numberGrouping` | `false` | locale digit grouping in grid cells only |
| `anthropicApiKey` | `""` | |
| `anthropicWorkspaceId` | `""` | optional `wrkspc_…`, sent as `anthropic-workspace-id` (identity-linked keys with several workspaces) |
| `aiModel` | `"claude-sonnet-5"` | picker: Haiku 4.5, Sonnet 5, Opus 5 |
| `aiEffort` | `"high"` | `low`/`medium`/`high`/`xhigh`/`max` |
| `aiMaxToolRounds` | `20` | |
| `aiMaxTokens` | `16384` | clamped by `clampMaxTokens` (`ai/model-limits.ts`): Haiku 64K, Sonnet/Opus 128K; over is a 400 |
| `aiChartFeedback` | `true` | feed chart PNG back to the agent |
| `aiTelemetry` | `true` | Sentry AI analytics opt-out |

- **A model ID must be in four places** or it degrades silently: the picker, `MODEL_PRICING` (`pricing.ts`), `MAX_OUTPUT_TOKENS` (`ai/model-limits.ts`), `ADAPTIVE_THINKING_MODELS` (`ai/model-features.ts`). `tests/unit/ai-model-features.test.ts` checks the first three agree. Old IDs migrate on load via `SUPERSEDED_MODEL_REPLACEMENTS` (`settings.tsx`).
- `aiEffort`: row hidden for models without adaptive thinking (`output_config.effort` is a 400 on Haiku 4.5). Read once per turn (a change invalidates the messages cache).
- `numberGrouping`: `formatCellValue`'s `grouping`, only from `DataGrid`/`DataPreview`; export, clipboard, AI (`query-results.ts`), terminal stay ungrouped. Type-gated (`BIT`). Swaps the decimal separator too (`de-DE` groups with `.`).
- `previewLayout`: `ValueInspector.tsx` is docked inline, not a portal (pop-out window). Width key `cupola.value-panel-width`. Lines records use `top`, not `translateY` (sticky ignores transforms).

## Other storage keys (localStorage unless noted)

| Key | Holds |
|-----|-------|
| `cupola.workspaces.v1` | Portable workspace records (`workspace/store.ts`) |
| `cupola.workspaces.local.v1` | Personal overlay: catalog colours, `enabled`, expanded roots |
| `cupola.workspaces.migrated.v1` | Boot migration marker (`workspace/migrate.ts`) |
| `cupola.catalog-secrets.v1` | Secret option values, `workspaceId:catalogId:option` (old `[url, catalogName, option]` keys: read-only fallback) |
| `cupola.query-history.v1::<workspace id>` | Query history |
| `vgi-sql-editor-docs::<workspace id>` | Editor tabs |
| `cupola.evidence.{report.v2,history.v1,draft.v1}:<workspace id>:<report id>` | Evidence reports, histories, recovery drafts |
| `vgi-recent-services` | Pre-workspace recents: read by migration and as a seed, never written |
| `<…>::<service URL>` / `<…>:<service URL>:<id>` | Pre-workspace copies: read-only fallback for one release |
| `cupola.session-workspace.v1:<id>` (sessionStorage) | `#ws=` link not yet consented to |
| `cupola-pending-sign-in` (sessionStorage) | `{workspaceId, pendingSignIns}` across a sign-in redirect |
