# Multi-catalog workspaces: design and phase plan

This is the agreed design for letting one Cupola tab attach several VGI catalogs, each
with its own URL and options. It records decisions that were already made, so treat it
as the spec. Each phase ends with `bun run check`, `bun run test`, the relevant
Playwright specs, and a CLAUDE.md update.

## Vocabulary (UI text)

- **Workspace**: a saved, ordered set of catalogs. Untitled ones save themselves.
- **Catalog**: one attached VGI (or Grainlift) source, inside a workspace.
- **Attach / Detach** a catalog.
- Never say "session" in the UI. The word already means OAuth sessions and
  sessionStorage.
- The Settings modal's Anthropic field keeps its full label, "Anthropic workspace ID".

## Data model

```ts
interface WorkspaceCatalog {
  id: string;               // stable uuid within the workspace
  url: string;              // service URL (vgi http(s) or grainlift+…)
  catalogName: string;      // catalog name ON THE SERVER (VGI catalogs()[i])
  alias: string;            // DuckDB database name; THE SQL CONTRACT
  options: Record<string, string>; // option name -> DuckDB text form of the value
  rawOptions?: string;      // escape hatch for a local hand edit only (validated)
  target?: string;          // grainlift target
  dataVersionSpec?: string;
  color: number;            // index into an 8-colour colour-blind-safe palette
  enabled: boolean;
}
interface Workspace {
  id: string;               // uuid
  name: string | null;      // null = untitled
  catalogs: WorkspaceCatalog[];
  defaultCatalogId: string | null;  // gets USE
  defaultSchema?: string | null;    // USE "alias"."schema"; else the server's default schema
  createdAt: number; updatedAt: number; lastOpenedAt: number;
}
```

### Aliases

- The default alias is the server's catalog name.
- Aliases must be valid SQL identifiers and unique within the workspace.
- `memory`, `temp`, `system` and `main` are reserved.
- On a collision, add `_2`, `_3`, … once, and **save the result**. Never recompute it,
  or an alias can change when the catalog order changes.

## Attach options (phase 0, prerequisite)

The research behind these rules has been verified:

- The VGI extension casts each declared option with `DefaultTryCastAs(spec.type)`.
- It rejects options the catalog doesn't declare.
- DuckDB's VARCHAR text form round-trips every type: STRUCT, MAP, LIST, INTERVAL,
  DECIMAL, TIMESTAMPTZ, BLOB, HUGEINT.

Rules:

- **Storage:** an option value is stored as its DuckDB **text** form.
- **Emission:** the ATTACH SQL writes it as `name 'text'`, using `quoteLiteral`.
  - Names must match `^[A-Za-z_][A-Za-z0-9_]*$`.
  - **No raw fragment from a URL is ever spliced in.** Today `buildAttachSql`
    (`shell-init.ts`) appends `attach_options` unescaped, which is SQL injection
    through a link.
- **Specs:** `client.catalogsInfo()` gives `attach_option_specs`. Decode them with
  `deserializeAttachOptionSpecs` from `vgi/client` (vgi ≥ 0.37.1). Each spec has
  `name`, `description`, `type` (Arrow), `default`, `required` and `secret`.
  - Upgrade `vgi` in package.json to `0.37.1` (an exact pin, as now).
  - **Check for duplicates.** If `@query-farm/vgi-rpc` must move together with it,
    move it, and keep `vite.resolve.dedupe` and the tsconfig `paths` in sync. See the
    "One Apache Arrow" rule in CLAUDE.md.
- **Validation before ATTACH:** use a prepared `SELECT TRY_CAST(? AS <duckdb type>)`.
  Map the type through `arrow-to-duckdb.ts`.
  - The extension's own built-in options (`pool`, `cache`, `data_version_spec`, …)
    have no spec. They are text.
- **Secrets:**
  - An option is secret when `spec.secret` is true.
  - For servers that predate the flag, it is secret when its name matches
    `/(key|token|secret|password|passwd|credential|auth)/i`.
  - Secret values never go into the workspace record, share links, exports, query
    history, console logs or Sentry. Extend `sentry-scrub.ts` to cover them.
  - Secret values live in a separate localStorage store, `cupola.catalog-secrets.v1`,
    keyed by `workspaceId:catalogId:option`.
  - They are written into the ATTACH inline. The extension redacts declared secret
    options from `duckdb_databases()` and hashes them in its cache key.
  - The `[shell] ATTACH SQL:` log line redacts them.
- **Legacy `attach_options` raw strings** (URL param and `vgi-recent-services`) are
  migrated once:
  1. Split them at top-level commas into `key value` pairs.
  2. Validate each value as one constant expression: `SELECT <expr>` through
     `json_serialize_sql`, which the shell already loads as the `json` extension. The
     AST node allowlist is CONSTANT, CAST, unary minus, and the functions
     `list_value` / `struct_pack` / `map` / `row`.
  3. Evaluate `(<expr>)::VARCHAR` and store that text.
  4. Anything that fails is reported to the user and dropped, never spliced in.
  5. If `json_serialize_sql` is unavailable, accept only plain string or number
    literals.
- **ConnectBox snippets** use the same structured builder, with quoted identifiers and
  literals.
- **`fetchCatalog` attaches with no options**, so the sidebar can differ from what
  DuckDB attached, and a `required` option breaks the fetch outright. Fix it by
  passing `optionsBytes` built from the specs, or by reading the tree from DuckDB
  after ATTACH, the way the inventory does for other attached databases. Either is
  fine. Prefer one source of truth.
- **Error panel for a failed ATTACH:**
  - the exact SQL, with secrets redacted;
  - a **Copy as duckdb CLI** button: INSTALL/LOAD plus the ATTACH, with secrets as
    `getenv('<ALIAS>_<OPTION>')`;
  - the HTTP status and VGI headers if available;
  - the extension, Cupola and server versions.

## URL contract

- **`?service=` is frozen forever.** It describes one catalog, together with
  `attach_options`, `target`, `name` and `data_version_spec`. Server redirects keep
  working unchanged.
  - Raw `attach_options` from a URL go through the legacy migration parser above, and
    only parse-validated values are used.
  - A URL that carries `attach_options` with non-literal expressions gets a
    **consent screen** before it attaches.
- **`#ws=<base64url(deflate(JSON))>`** carries a portable multi-catalog spec in the
  fragment. Reuse the `share-query.ts` codec.
  - The JSON is the workspace file format below.
  - It contains **no secret values**.
  - Opening one shows a **consent screen** ("This link wants to attach 3
    catalogs: …") and creates an untitled workspace.
- **`?local_ws=<id>`** names a workspace in this browser's localStorage. It means
  nothing to anyone else. The Share button must produce `#ws=`, never this.
- **Server redirect versus a named workspace:**
  - `?service=X` opens an untitled workspace containing X. It is de-duplicated by a
    fingerprint of the catalog set, so repeated redirects reuse one workspace.
  - It **never** modifies a named workspace. If a named workspace already contains X,
    show a banner: [Open "<name>" instead]. Otherwise: [Add to "<name>"] for the last
    named workspace.

## Engine (phase 1)

- **`ShellConfig.catalogs: AttachSpec[]`.** Attach one at a time, which keeps the
  OAuth SharedArrayBuffer popup safe.
  - Each catalog gets its own result:
    `connecting | attached | sign-in-required | failed(error, sql) | disabled`.
  - One failure never sets the engine's error state.
- **`USE`** the default catalog and its schema, quoted:
  `USE "alias"."schema"`. If the default fails, fall back to the next catalog that
  attached, and say so.
  - Reports and saved queries re-apply the workspace default before they run
    (`USE` is connection-wide).
- **`engine.attached`** resolves when every catalog has settled. Per-alias status
  goes on the bridge and can be subscribed to.
- **Inventory:**
  - `catalog-inventory.ts`'s single `bootstrap` becomes `Map<alias, connection>`, with
    `sourceUrl`, options and identity for every catalog.
  - "primary" becomes "default".
  - AI callers already take catalogs; keep them working.
- **Hash routes:** `#/catalog/<alias>/schema/<s>/table/<t>`.
  - Legacy `#/schema/...` resolves against the default catalog.
  - `updatePageTitle` uses `sel.catalog`.
  - The Breadcrumb root carries `catalog`.
- **Small fixes:**
  - `TableDetail.tsx:29` builds an unquoted identifier.
  - `shell-init.ts`'s `USE` is unquoted.
  - `fetchColumnStats` must only run for vgi catalogs.
  - The Sentry `service` tag becomes the list of services.
- **Test worker:** add a way to serve a second catalog, e.g. run `test-worker` on
  two ports, or a second catalog in the same worker. Then cover in Playwright:
  - two catalogs attached;
  - one failing while the other works;
  - alias collisions;
  - a deep link into the second catalog.

## Auth

- **Tokens:** `oauth-client.ts` keeps tokens per origin, which is fine.
- **Redirect guard:** the redirect-loop guard (`_vgi_auth_redirect_ts`) becomes per
  service.
- **Sign-in is a manual click per catalog.**
  - Catalogs that need no auth attach first.
  - A catalog that needs auth shows **Sign in required**.
  - Clicking Sign in redirects, after saving `{workspaceId, pendingSignIns}` in
    sessionStorage, the same pattern as `vgi-pending-share-sql`.
  - When the user comes back: "Signed in to X. 1 more needs sign-in: [Sign in to Y]".
- **Never chain redirects automatically.**
- Legacy `#token=` fragments apply only to the `?service=` catalog.

## Storage scoping and migration (phase 2)

| Item | Scope |
|---|---|
| Editor tabs (`editor-store.ts`) | Per workspace |
| Evidence reports, report history and drafts | Per workspace, with "Copy to workspace…" |
| AI chats | Per workspace |
| Query history | **Stored per workspace**, plus an "All workspaces" toggle in the History menu that reads every store and labels each entry with its workspace |
| Settings, API key, theme | Global |
| OAuth tokens | Per URL origin, as now |

**Migration runs once at boot**, idempotently, behind a version marker
(`cupola.workspaces.migrated.v1`):

- Every `vgi-recent-services` entry becomes an untitled single-catalog workspace. Its
  alias is the old catalog name, which keeps reports working.
- Re-key editor tabs, query history and Evidence reports (with history and drafts)
  from `<service>` to the workspace id.
- **Keep the old keys** as a read-only fallback for one release. Don't delete them.

## Picker, top right (phase 2)

**Trigger:** it shows what is connected, not who is signed in.

- `[●] sales ✓ ▾` for one catalog.
- `[●●●] Finance Q3 · 3 catalogs ▾` for several.
- `· ⚠ 1 needs sign-in` when degraded.

**Dropdown:**

- The workspace name, with Rename.
- **CATALOGS IN THIS WORKSPACE.** Each row shows a colour chip, the alias, a star for
  the default, a status, the host, and the signed-in identity per catalog
  (`getUserInfo`). Rows offer Sign in or Retry inline. The ⋯ menu has: Edit options…,
  Make default, Sign out (this catalog), Copy URL, Detach (undo toast, no confirm).
- **+ Attach a catalog…** opens an inline form in the current workspace:
  - the URL;
  - the alias, prefilled;
  - typed options from the specs: masked inputs for secrets, required ones marked;
  - a checkbox list when the service exposes several catalogs, all ticked;
  - Test connection.
- **SWITCH WORKSPACE** lists recent named and untitled workspaces, and offers
  Manage workspaces… (phase 3).
- **Share workspace link…** produces `#ws=`, with no secrets. It warns about which
  options are left out.
- **Sign out of all catalogs.**

Every catalog gets **its own** sign-out. Today's single identity on the trigger goes
away.

## Sidebar (phase 2)

- **Catalog roots:**
  - a colour chip with the alias's initial, so colour is never the only cue;
  - the alias, with the host in a tooltip;
  - a star for the default;
  - a status. Failed and sign-in roots show their action inline and don't expand.
- `memory` stays pinned at the bottom below a divider, labelled "local".
- **Expansion:** with one catalog, expanded. With several, the default is expanded and
  the rest collapsed. Expansion is remembered per workspace.
- **Attention strip:** one dismissible strip at the top, e.g. "1 of 3 catalogs needs
  attention". Don't use toasts. Per-catalog details open from there.
- **Empty workspace:** "No catalogs attached [Attach a catalog]".
- **All failed:** a full-panel list with Retry and Edit per catalog.
- Status changes are announced through a batched `aria-live="polite"` region.

## Welcome page (phase 2)

- **First visit:** one URL field, an optional options disclosure, and "+ Add another
  catalog". No mention of workspaces.
- **Returning user:** the connect field at the top, then workspace cards (name and
  catalog chips) and a Recent list.

## Phase 3: editor and config-as-code

- **Manage workspaces:** a two-pane sheet with workspaces on the left and the selected
  one on the right.
  - Rename, duplicate and delete.
  - Reorder by drag, plus Move up/down for the keyboard.
  - Per catalog: alias (validated), colour, URL, enabled, default, Test connection.
  - The options grid is driven by the specs (switch, number, date, text,
    DuckDB-syntax text for nested types, help text from the description), plus a raw
    SQL tab that is still parse-validated.
- **Renaming an alias** warns with counts of the reports and editor tabs that
  reference the old `alias.`, and offers to rewrite them through DuckDB's parser
  (`json_serialize_sql` + `json_deserialize_sql`), or just to warn.
  - As built (phase 3C): a SQL tokenizer instead (`workspace/alias-rewrite.ts`). A
    deserialized statement comes back reformatted, losing comments and layout, and
    counting needs no booted engine. See CLAUDE.md for what counts as a reference.
- **Workspace file:**
  - `{"$schema": ".../workspace-v1.json", "format": "cupola-workspaces", "version": 1, "workspaces": [...]}`.
  - Publish the JSON Schema at `public/schema/workspace-v1.json`.
  - A stable `id` lets an import update the existing workspace. On a conflict,
    offer replace or keep both.
  - Personal state (colour, enabled, expansion) is not part of the portable record.
    Keep it in a local overlay.
  - Secrets are excluded, always.
  - It is the same JSON as `#ws=`.
- **Export as DuckDB script:**

  ```
  INSTALL vgi FROM community; LOAD vgi;
  ATTACH 'cat' AS "alias" (TYPE vgi, LOCATION '…', opt 'v', api_key getenv('ALIAS_API_KEY'));
  USE "alias"."schema";
  ```

  Generate it with the same builder the engine uses.
- **Import from a DuckDB script:** parse only `ATTACH … (TYPE vgi …)` and `USE`, and
  refuse anything else.
- **Reports record `requires: [{alias, url, catalogName}]`.**
  - On open, if the current workspace holds the same catalog (same url and
    catalogName) under a different alias, offer **Rebind**: rewrite the qualified
    references.
  - If it's missing, offer **Attach**.
  - Report files carry `requires` too.
- **⌘K command palette:** Switch workspace…, Attach catalog…, Sign in to X, Retry X,
  Make X default, Manage workspaces.

## Out of scope (phase 4)

- popup sign-in, or reusing one sign-in across catalogs from the same issuer
- `?workspace_url=` manifests
- server-side option autocomplete beyond the specs
- SDK link helpers
- team or shared workspaces
