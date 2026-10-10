# Worker report libraries in Cupola

Cupola probes the workspace's connected HTTP services for `vgi.reports.v1` and
combines their visible reports with browser-local reports in **All reports**.
The **Location** column identifies each source. The main catalog sidebar has one
**Reports → library → folders → reports** tree, available in every app tab.
Browser-only reports live under **Reports → Local**, alongside worker libraries;
they are no longer listed under the sidebar's **On this device** section.
Click Reports for the combined listing, a library or folder for its contents, or
a report to open it. The report page has no second navigation sidebar.
The worker's existing
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

**Save a copy…** and **Move…** in the report's action menu use the same folder tree to select a location and
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
- `ReportsSidebar` puts libraries, folders and report links in the main sidebar.
  Filtering reveals matching reports with their parent folders. Links preserve
  browser Back/Forward, new-tab clicks and workspace context. Successful worker
  mutations refresh that library's tree; denied reads clear its previous entries.
- `ReportLocationsProvider` shares protocol discovery between the sidebar and
  report pages, deduplicating catalogs that use the same worker endpoint.
- `ReportStorageTree` adapts local and worker folders for transfer dialogs.
  `ResourceDialog` uses
  `FileTree` for folder creation and moves within a worker, excluding a folder's
  own descendants as move targets.
- `ReportFileList` renders the contents of both local and worker directories.
- `ReportNotice` standardizes permission, information, and error messages with
  icons, concise text, and optional actions.
- `ReportHeader` is the single header for local and worker reports. It shows the
  report title, library/folder, save status, refresh, view/edit and Share.
- `ReportActionMenu` shares action names and menu behavior between the header and
  library rows. Version history, details, copying, moving, downloads and deletion
  are secondary commands; ownership transfer lives inside Details.
- `ReportDetailsDialog` displays metadata and ownership, with edits and ownership
  transfer offered only when available. Pending saves block metadata changes.

Click a report's title to rename it. **Share** on a local report offers saving a
copy to a report library or downloading a copy. Worker sharing offers links to
the latest available version or the specific saved version being viewed. The
worker decides what the recipient can access; copying a link grants no access.
Publishing controls live in Share, with a contextual **Publish changes** button
while editing an unpublished draft. Saving never publishes automatically.
Unpublishing asks for confirmation and preserves saved definitions and history.
There is one Move command for both folders and locations. Same-library moves
retain identity and history and require move permission; cross-library moves
also require permission to delete the source. The destination is checked separately.

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
- Browse revision authors, timestamps and messages; open a revision read-only,
  compare any two saved definitions, restore an earlier revision as a new revision, publish or
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

## Revision history

Open a worker report and choose **⋯ → Version history**. Each entry shows the worker-recorded
author, timestamp, revision kind and message, with markers for the current,
published and viewed revisions. **View revision** opens a read-only, revision-pinned
URL that survives reload and browser back/forward navigation. **Open current
report** returns to the editable head when the worker permits editing. Pending
edits or unresolved saves must finish before opening or restoring another revision.

**Compare changes** starts with adjacent readable revisions. The native **From
revision** and **To revision** selectors can compare any two visible revisions.
Comparisons show title, description, tags, data sources, protocol parameters,
document source (including SQL), setup SQL, report parameters, appearance and
other stored fields. Unknown fields are retained; JSON whitespace and property
order are distinguished from content changes. Large fields use bounded before/
after excerpts with complete downloads; binary bodies can be downloaded for
inspection. Comparisons use fresh authenticated reads, clear stale content when
selections change, and offer retries for failures. Redacted content is unavailable.

Viewing and comparing definitions does not execute queries, write revisions or
restore data snapshots. A preview uses current data and requires an explicit
refresh. The worker assigns revision authorship from the request identity;
Cupola does not supply an author or infer one from browser-local history. The
reference worker's explicit local demo identity records `operator`; distinct
authenticated accounts record their own identities.

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
