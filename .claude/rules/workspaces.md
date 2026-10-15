---
paths:
  - "src/lib/workspace/**"
  - "src/components/workspace/**"
  - "src/components/ServiceSwitcher.tsx"
  - "src/components/CatalogApp.tsx"
  - "src/components/Sidebar.tsx"
  - "src/lib/catalog-inventory.ts"
  - "src/lib/catalog-store.ts"
  - "src/lib/attach/attach-catalog.ts"
  - "src/lib/shell-bridge.ts"
  - "docs/multi-catalog.md"
  - "tests/multi-catalog.spec.ts"
  - "tests/workspace*.spec.ts"
---

# Multi-catalog and workspaces (`docs/multi-catalog.md`)

## Loading and attaching
- RPC loads run in parallel (`workspace/load.ts`); after all settle the shell attaches **one at a time** (`attach/attach-catalog.ts`; the OAuth popup returns codes through one SharedArrayBuffer), then `USE "alias"."schema"`.
- Failure is per catalog (`CatalogStatus`), never the engine's lifecycle error; `engine.attached` resolves once all settle. Full-page error only when all fail.
- One catalog keeps old behaviour (`single` in `AttachCallbacks`: auth redirect, immediate error panel, full-page options form); server redirects and older specs depend on it. Several: no auto or chained redirects; **Sign in** saves sessionStorage `cupola-pending-sign-in` first. Loop guard is per service (`_vgi_auth_redirect_ts:<url>`).
- Legacy `#token=` belongs only to the `?service=` catalog (`setLegacyAuthService`). Tokens looked up per catalog at ATTACH (`getAuthTokenForService`), never in shell config.
- `USE` falls back to the next attached catalog (`engine.defaultCatalog.fellBack`); a missing schema falls back to the catalog's default.
- Trap: the shell plan is frozen at first render (`shellPlanRef`); a changed `catalogName` re-runs shell init and leaves `engine.attached` unresolved. Later attaches: `attachCatalog` after `await engine.attached` (`loadAndAttach`). Live changes never re-init the shell.
- Read the default catalog's data only after all settle. `initAttached` (`shell-bridge.ts`) hands old waiters to a new attach cycle.
- Detach/Disable of the default moves `USE` first (DuckDB refuses to detach the default).

## Aliases (the SQL contract)
- Assigned once at normalisation (`workspace/aliases.ts`), stored, **never recomputed** (order changes would move them). `memory`/`temp`/`system`/`main` reserved; unique case-insensitively; collisions `_2`, `_3`.
- A `?service=` catalog keeps the server's catalog name exactly (saved reports reference it).

## Inventory and sidebar
- `catalog-inventory.ts` binds connections by database oid: only the first attach of a configured alias gets connection context, not a manual re-ATTACH. Retry calls `rebind(alias)` first.
- The default sorts first (`CatalogData.isDefault`); AI callers' `catalogs[0]` relies on it.
- Chips (`--catalog-chip-0…7`, `catalog-colors.ts`) carry the alias initial so colour is never the only cue.

## Store (`workspace/store.ts`)
- **Portable** `cupola.workspaces.v1`: catalogs (URL, server name, alias, non-secret options, pending raw text, target), default, timestamps, `legacyServiceUrl`. **Personal** `cupola.workspaces.local.v1`: colour, `enabled`, expanded roots; never in links or files. **Secrets** in neither (`cupola.catalog-secrets.v1`, `workspaceId:catalogId:option`).
- Untitled de-dup by `fingerprintOf` (URL + server name + target, order-free). `?service=` matches by URL + target (`findUntitledForService`). Max 10 untitled; pruned ids kept by fingerprint (`retired`).
- Renaming an untitled workspace moves the tab to `?local_ws=`.
- **A redirect never changes a named workspace**; only the reader's [Add to "<name>"] does.
- Full storage: retire oldest untitled (never the open one), retry, else memory-only + `lastSaveError()`.
- Options persist via `OptionSink` / `catalogOptionSink`; never `vgi-recent-services`.

## Migration and legacy keys
- `workspace/migrate.ts` (marker `cupola.workspaces.migrated.v1`) copies, never moves, each `vgi-recent-services` entry and its data to an untitled workspace; never overwrites, so idempotent.
- Old keys are a read-only fallback (`legacy-scope.ts`): read workspace id then service URL, write only the workspace key. Delete removes both copies, or the fallback resurrects it.
- Reports (`reportScope`) and notebooks (`notebookScope`, `cupola.notebook.v1:<scope>:<id>`) keyed `workspaceId`, else legacy `serviceUrl`. Gap: notebooks have no `requires` and aren't rewritten by alias rename.

## Picker (`ServiceSwitcher.tsx`)
- ⋯ menus are inline: a portalled menu counts as a click outside the popover.
- Detach has undo, no confirm (secrets keyed by catalog id survive).

## Welcome page
- Multi-catalog service: only the **first** catalog ticked, so an unchanged Connect is plain `?service=` (`planConnect`).
- `catalogs_info` needs auth: **Sign in to list catalogs** (`catalog-discovery.ts`; sessionStorage `cupola-pending-connect` / `cupola-pending-attach`). Awaits `consumePendingCallback()` first, since the welcome page never exchanges the code otherwise.

## Manage workspaces (`WorkspaceManager.tsx`, `workspace/manager.ts`)
- Toggles apply at once; connection fields are a draft applied only by **Save** (a half-typed URL never re-attaches).
- Open workspace: `LiveWorkspaceHooks` instead of the store; Save = `reattachCatalog`. It can't be deleted from here.
- Duplicate: new ids, same aliases, always **named** "(copy)" (an untitled copy would share the fingerprint); secrets copied.
- `reorderCatalogs` refuses dropped/repeated catalogs. SQL tab: `optionsToSqlText` (no secrets) ↔ `sqlTextToOptions`; nothing spliced into SQL.
- Alias edits go through `onAliasRenameRequested`, which must resolve true once renamed. `testServiceConnection` skips the RPC attach if a spec is `required`.

## Tests
- `multi-catalog.spec.ts`, `workspaces.spec.ts` (two workers), `workspace-manager.spec.ts`, `unit/workspace-manager.test.ts`.
