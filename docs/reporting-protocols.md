# Worker report libraries in Cupola

Cupola probes the workspace's connected HTTP services for `vgi.reports.v1` and
combines their visible reports with browser-local reports in **All reports**.
The **Location** column identifies each source. A folder tree inside the browser
contains **All reports**, **On this device**, and named worker locations. Expand
locations and folders with their chevrons, then select a folder to list its contents.
The editor has no separate location toolbar. The worker's existing
`get_report_service_info().display_name` supplies its drive name. URLs remain
connection identities and appear only as details or to distinguish duplicate names.

**New report** in the combined browser starts locally, including when a worker
is read-only or unavailable. The tree keeps local storage reachable. A compact
permission notice with a lock icon offers **New local report** in read-only locations. A worker
location can create reports directly when its current folder allows it; otherwise
New report opens a local draft and the page explains the missing permission.
Folder creation respects the worker's current `allowed_actions`; local folders
need no worker permission. Local reports and folders remain scoped to the current
workspace and browser.

**Copy to…** and **Move to…** use the same folder tree to select a location and
destination folder. Read-only destinations carry a lock icon and explain why
the operation is unavailable; they can still be expanded to show writable children. Reports
can transfer between local storage and workers, or between workers. A move within
a location retains its identity and history. Across locations, Cupola copies the
current saved definition into a new draft with destination-owned permissions;
history, publication and original ownership do not transfer. The dialog explains
this before dispatch. Historical revisions can be copied, but cannot replace the
current definition in a cross-location move.

Cross-location moves confirm the destination before deleting the source using its
original version precondition. Lost replies retain a durable transfer record with
the exact request IDs, body and account scopes; retries survive page reloads and
never silently start another copy. Conflicts keep both copies for review. Each
worker receives only its own credentials. **Stop retrying…** removes the local
retry record after explaining that a request may already have succeeded. Transfers
older than the protocol's 24-hour retry window require manual inspection.

Discovery and listing failures are isolated by location. They do not hide reports
from healthy workers or prevent local creation. **Refresh** rechecks capabilities
and permissions. Existing local file import/export and recovery drafts remain
available in the combined browser.

## Shared browser components

- `FileTree` provides selection, independent expansion, keyboard navigation,
  type-ahead, and accessible tree semantics.
- `ReportStorageTree` adapts local and worker folders to that tree. It is shared
  by the browser and cross-location transfer dialogs. `ResourceDialog` uses
  `FileTree` for folder creation and moves within a worker, excluding a folder's
  own descendants as move targets.
- `ReportFileList` renders the contents of both local and worker directories.
- `ReportNotice` standardizes permission, information, and error messages with
  icons, concise text, and optional actions.

The UI uses filesystem conventions; workers still define access policy and
validate every mutation. A folder's appearance in the tree does not grant write
access. Arrow keys navigate or expand, Enter/Space selects, and Home/End or typing
finds a visible item. Expansion does not select a destination.

## Implemented workflows

- Discover named libraries on attached services and combine their contents.
- Browse nested folders, search descendant reports, and filter by publication
  or ownership. Create, rename, move, and delete folders; create, edit, move,
  copy, and delete reports.
- Use the existing Evidence editor, parameters, preview, AI proposals and PDF
  export. Opening a worker report does not run its SQL. Refresh is explicit.
- Autosave immutable worker revisions with the head revision as a precondition.
  Reader-selected filter values remain a local view and do not create revisions.
- Inspect history, restore an earlier revision as a new revision, publish or
  unpublish, and redact eligible historical revisions with a reason.
- Display author, owner and durable parent; transfer report/folder ownership
  through worker-resolved identity references. Cupola does not define an ACL
  policy or assume permission inheritance. Every operation remains subject to
  worker authorization, even when its permission hint previously allowed it.
- Share credential-free report links and links pinned to a revision. Recipients
  authenticate independently. Publication does not imply public access.
- Import a current definition from this device or a single-report Cupola file.
  The original history remains at its source; Cupola does not impersonate its
  authors by replaying their revisions into a new worker report.

Other reporting protocols (render, schedules, tasks, alerts, notify and owned
resources) are not hosted by the current reference worker. This implementation
does not manufacture those capabilities. Preview/PDF execution remains in
Cupola, with the reader's current catalog connections.

## Contracts and transport

`src/lib/reporting/contracts.generated.ts` is generated from the actual Python
dataclasses in SDK commit `7b5301406bca63677ff61cdd58978b697046fa43`:

```sh
../vgi-reporting-protocol-reference/.venv/bin/python scripts/generate-reporting-contracts.py
```

The generated file contains TypeScript record/method types, all explicit method
defaults, structured-argument mappings, and Arrow schemas. The browser uses the
existing VGI RPC HTTP client, with `vgi.reports.v1` selected explicitly. Unary
arguments are individual fields; dataclass arguments and return values use
their one-row Arrow IPC encoding. Streams are consumed through their final
continuation and closed. Version/precondition values remain exact `bigint`s.

Tokens come from Cupola's existing per-service authentication. Authorization is
restricted to the selected service's origin and path, with redirects rejected;
external object URLs do not receive that header. Recovery is partitioned by
service and a token digest. Tokens themselves are never written into report
records, links or mutation journals. A changed token requires the original
credential to retry its journal; this conservative boundary also applies to
rotated opaque credentials.

## `cupola.evidence/1` body

The body is UTF-8 JSON:

```json
{"version":1,"document":{"version":1,"source":"# Report","setupSql":"","parameters":[]}}
```

`document` carries the fields of Cupola's version-1 Evidence report definition:
source, setup SQL, parameters, requirements, appearance, semantic datasets,
pivots and drill paths. It excludes the browser report ID, local workspace ID,
service URL, selected input values, timestamps and title. The envelope owns the
title, description, tags and data-source metadata; the worker owns resource
identity, timestamps, ownership and revision identity. Decoding binds that
definition to the current browser workspace without automatically attaching or
executing its required catalogs.

The envelope exposes controls that exactly match protocol parameter semantics.
Query-derived choices, select controls with “all”/dynamic default modes,
empty/mixed/duplicate choices or defaults outside the wire contract, and
Cupola's inclusive date ranges remain native controls in the body. They are
listed in the UI as **Cupola-only controls**, not advertised with an incorrect
static-option or half-open-range contract. A future renderer must understand
this body format to execute those controls. Missing required inputs are still
checked by Cupola before preview.

Unknown body formats, malformed bodies and redacted revisions cannot enter the
editor/save path. An available original body can be downloaded without
interpreting it. Worker body-format and size limits are checked before saving;
the worker remains the authority on all validation and quotas.

## Save and recovery behavior

`SaveController` persists the latest draft immediately and serializes revision
writes. A request journal is written **before dispatch** with the exact request
ID, envelope, body and precondition. Edits typed while that request is in flight
remain separate. Autosaves can coalesce queued edits; explicit agent and restore
boundaries are retained.

A transport timeout or lost reply leaves an unconfirmed request. **Retry save**
reuses its original ID and payload, then sends newer edits against the
acknowledged head. There is no blind automatic retry loop. An explicit worker
refusal clears the request journal but preserves the draft. A conflict blocks
saving and offers loading the latest version, saving the draft as a copy, or
exporting it. Loading the latest retains the old draft in the library's recovery
list. Recovery never opens private cached content before a fresh authorized
worker read.

The same write-ahead mechanism covers library mutations. Web Locks serialize
access to a shared journal across tabs. Requests older than the protocol's
24-hour replay guarantee require inspection and explicit discard instead of a
new request ID being silently assigned. Draft storage failures are visible;
failed journal writes prevent dispatch. Recovery data stays on the device until
acknowledged or explicitly discarded. Users can export drafts when access is
revoked. This is not an offline library mirror or background synchronization
service.

## Run against the reference worker

In `../vgi-reporting-protocol-reference`, configure `REPORTING_TOKENS` using the
worker README, set `REPORTING_DB` to a durable database path, and run:

```sh
VGI_INTROSPECT_PRINCIPALS=operator uv run reporting-worker --http --host 127.0.0.1 --port 9137
```

In this worktree:

```sh
bun install --frozen-lockfile
bun run dev -- --port 4337 --strictPort
```

Open Cupola's `/v<package-version>/reports` route with
`?service=http://127.0.0.1:9137`. Use the existing authenticated service connection
flow; the reference worker's development bearer token can be supplied through
Cupola's existing `#token=` fragment. Never put credentials in query parameters.
Without a token, the reference worker exposes only its anonymously readable
published reports, with no write actions.

## Verification

The 0.4.226 integration review checked all 17 methods against the pinned Python
SDK and reference worker. Regenerating the Arrow schemas and method signatures
produced no drift. HTTP tests cover every method, lost-response replay, and a
130-folder listing that crosses the worker's continuation boundary.

The review fixed two integration defects: native controls that did not satisfy
the public parameter contract could prevent saving, and the editor could retain
an older, apparently dirty definition after a save and resubmit it when details
changed. The editor now tracks the queued canonical definition, and details
updates wait for pending saves. Browser regression tests cover that transition.

```sh
bun test ./tests/unit
CUPOLA_APP_ORIGIN=http://localhost:4337 bun run test:reporting
bun run check
bun run build
```

The reporting tests launch a real isolated Python HTTP worker with a temporary
database, ephemeral port and test identities. By default they use
`../vgi-reporting-protocol-reference/.venv/bin/python`; set
`CUPOLA_REPORTING_PYTHON` for another installation. They do not call Yahoo.
Integration tests exercise every protocol method, Arrow interoperability,
permissions and CAS conflicts, plus a deliberately dropped reply after an
admitted mutation. Browser tests cover hierarchy, editor/preview integration,
sharing in a fresh context, interrupted saves, concurrent writers and permission
revocation.
