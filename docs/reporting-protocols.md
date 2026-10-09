# Worker report libraries in Cupola

Cupola consumes `vgi.reports.v1` over HTTP. A connected service advertising this
protocol appears in the **Report library** selector. **On this device** retains
the existing browser-local reports and history. Import explicitly copies a
local definition to a worker; it never deletes or replaces the local report.

## Implemented workflows

- Discover libraries on attached services and switch between them.
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
Query-derived choices, select controls with “all”/dynamic default modes, and
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
