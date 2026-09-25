# Evidence reporting evaluation

Run `bun install` and `bun run dev --host 127.0.0.1 --port 4323`, then open
http://127.0.0.1:4323/v0.4.170/evidence in Chrome. The separate worktree is
`vgi-web-frontend-evidence`, branch `feature/evidence-reporting`.

The Reports tab embeds the real Evidence Core Svelte/Markdoc renderer in
Cupola's React shell. The toolbar, library and editor use Cupola controls and
theme tokens. Only the document renderer uses a shadow root; it shares the JavaScript
realm and the existing Haybarn engine. The shell owns WASM startup, extension
loading and service attachment. Report refreshes, source edits and tab switches
do not create engines.

The example uses the public Open-Meteo VGI service listed at https://query.farm/vgi/.
Two US city parameters are bound with `queryPrepared` into the geocoding/forecast
query. `cupola_weather` contains tagged daily and hourly records: seven complete
local-calendar-day forecasts from `forecast_daily`, plus upcoming hourly weather
left-joined to hourly air quality by city role and UTC timestamp. Geocoding is
materialized once. Daily requests use `timezone := 'auto'`; the connector emits
UTC instants, converted back to each city's timezone for the daily date. Named
VGI arguments are constants, so the connector's `auto` option is essential here.
Evidence SQL fences then query that table through the shared engine. The adapter
uses Evidence's DuckDB-compatible dialect, converts Arrow results to rows and
coalesces repeated SQL for each report run. Apply/Refresh creates a fresh adapter
cache. No MotherDuck account or separate database is involved.

`src/lib/evidence/open-meteo.md` is the editable seven-day briefing:

- Primary-city narrative, weekly high/low/precipitation cards and a sparkline.
- Expandable city groups, seven local dates, and native delta arrows for daily
  highs/lows. Changes use LAG partitioned by city role and ordered by date. The
  first day's delta is null, and delta columns are hidden on weekly subtotal rows.
- Daily high/low comparison charts with identical data-derived bounds, supplied
  through Evidence repeat variables, and a precipitation chart with a dry-week
  conditional alternative. The heatmap is removed.
- US AQI trend with reference lines, next-available-hour categories and PM2.5,
  a pollutant chart, and progress bars for actual non-null AQI coverage. Requested
  coverage is seven days, but missing values are never filled with zero.
- Upcoming hourly weather and raw-data tabs, followed by source/methodology notes.

Temperature is Fahrenheit, wind mph, precipitation inches, and pollutant
concentrations µg/m³. Daily rows follow local dates; hourly comparisons use UTC.
Today is explicitly a full-day forecast, not only the remaining hours. AQI is
modelled forecast data, not an observation. Air quality is attributed to Open-Meteo
and CAMS. The source connector is `../vgi-open-meteo` (read-only during this work).

## Authoring, parameters and saved reports

**Edit report** exposes title, parameter definitions, optional dataset setup SQL,
and Evidence markup. Parameters support text, number, date and boolean types,
with a name, display label, default and required flag. The reader's controls are
generated from these definitions. For example, define `city` as text and write
`SELECT $city AS city` in a SQL fence, or use `$city` in the dataset setup query.
Do not quote parameter references. Cupola's existing parameter compiler turns
references outside SQL strings/comments into `?` placeholders; Haybarn binds the
values. Report parameters work in both setup SQL and Evidence-generated queries.
Unknown names, missing required values and type errors are reported. Binding is
for values, not table names or SQL fragments.

**Refresh report** reruns dataset setup and mounts the document with a fresh
query cache and a snapshot of current parameters. Input changes do not silently
rerun a report. **Apply changes** performs the same refresh from the editor.
All actions reuse the shell's Worker; no additional engine is created.

**Save report** stores the title, source, setup SQL, parameter definitions,
selected values and service URL in localStorage, under versioned per-report keys
`cupola.evidence.report.v2:<encoded-worker-url>:<encoded-report-id>`. Saving does not save result rows. **Save a copy**
creates another ID. Storage and validation failures are surfaced; failed saves
do not claim success. No existing block-report IndexedDB data is changed.

**Saved reports** opens `/v0.4.170/reports/saved`, with search, open, create and
delete actions. A saved report URL carries `?evidence_report=<id>` and resolves
only in the same browser/origin. Reopening reruns its datasets with saved values;
a service mismatch requires opening its saved service connection. Draft edits
survive a visit to the list; replacing a modified draft asks before discarding it.
Browser reload/navigation also warns about modified drafts. Storage changes from
other tabs update the list.

## Evaluation boundaries

- Core is an internal, private upstream source package, not a published embedding
  SDK. `vendor/README.md` documents the pinned MIT source package. Integration
  depends on its context APIs, Svelte resolver compatibility and SvelteKit shims.
- This is a report-authoring/rendering experiment. Cross-browser sharing, financial
  statement layout and reliable paginated PDF export are still to implement.
- Dataset setup SQL can create temporary tables shared by the document. The weather
  example is a template; new blank reports can query the current connection.
- Reports execute with the current user's engine access. The editor is intended
  for trusted authors; it is not a sandbox for untrusted JavaScript or SQL.
- The adapter retains large integers/decimals as strings to avoid conversion
  loss, but Evidence components may coerce them for formatting/aggregation.
  Financial precision needs end-to-end validation before adopting it for NAVs.
- The renderer pulls in a broad component library. Bundle size, font assets,
  accessibility and production PDF behavior need attention before shipping.

## Validation

`bun run check`, `bun run build`, and
`bun test tests/unit/evidence-query-service.test.ts tests/unit/evidence-reports.test.ts` validate the integration.
The live Chrome regression test is:

```
CUPOLA_APP_ORIGIN=http://127.0.0.1:4323 bunx playwright test tests/evidence.spec.ts --workers=1
```

The report leads with timestamped current conditions from `forecast_current` and
24 upcoming hourly samples per city for temperature, relative humidity, and mean
sea-level pressure. Current timestamps are local; comparison graphs use UTC.

It checks current readings and 24 consecutive hourly samples per city, seven daily dates per city, grouping/collapse, high/low change columns,
AQI coverage controls, chart tabs, report editing, refresh and tab switching,
no browser exceptions, and preservation of the exact shell Worker object. A
second test covers all four parameter types, SQL-like text as bound data, saving,
reopening after reload, copying, deleting, and the saved-report list. The test
requires Chrome and network access to the live weather service.

## Editing and viewing

Report inputs appear inside the report card above its content and scroll with it. The section-jump dropdown has been removed. In split editing, the report is on the left and the editor is on the right; on narrow screens, the report is above the editor.
Edit mode separates Document, Data, and Parameters into tabs beside an independent
preview; narrow layouts stack the two panes. The document editor offers component
snippets with placeholder datasets and columns. Update preview applies the draft
and reruns its queries; Save report stores the draft locally. A pending-change
indicator distinguishes the source from the last rendered preview.

Cmd/Ctrl+Enter updates the preview, and Cmd/Ctrl+S saves. Focus mode expands the
workspace over the application chrome; Escape exits and covered controls are
removed from keyboard navigation while focused. Jump to section is populated from
the rendered report's headings. Query diagnostics appear only in edit mode.

### Full-screen authoring and diagnostics

Full-screen editor expands the workspace and hides the preview. Show preview
restores the split while retaining focus mode; Escape exits focus mode (or closes
an active completion menu first). Switching layouts preserves the report draft.

The Document and Data tabs use CodeMirror with line numbers, Markdown and SQL
highlighting, Evidence tag highlighting, and Ctrl+Space completion. Component and
attribute suggestions come from the installed Core schema registry; query names
come from document SQL fences, and parameter suggestions use the report's input
keys. SQL keyword completion is included; this is not a SQL language server with
catalog-aware column completion. Documentation links point to the current
Evidence Markdown and component documentation, rather than the legacy Svelte
component syntax.

Update preview runs validation and queries explicitly. The Problems panel shows
Core validation errors with one-based source lines and editor markers; clicking
an error opens the corresponding editor and line. Warnings are advisory and
collapsed separately. Query failures include the executed SQL, and setup failures
point to the Data tab. Runtime rendering failures are caught by a Svelte boundary
or the mount handler so the surrounding editor remains usable. Editing marks
previous diagnostics stale and removes their editor markers until the next run.
Core's named SQL queries must be registered by transformation before validating
references to them; validation is repeated after that registration.

`tests/evidence-authoring.spec.ts` checks full-screen layout, completion, error
locations, correction/recovery, failed document SQL and setup SQL, and preservation
of the shared engine. These checks complement `tests/evidence.spec.ts`.

### Report authoring agent

Edit report opens Chat alongside Code, Data, and Parameters. It uses
Cupola's existing Anthropic streaming agent, credentials, model, effort and token
settings. Conversation and proposals survive switching editor tabs and View/Edit;
opening another report resets the agent and aborts its request. Conversations are
session-only and are not included in saved report documents.

The agent receives the current report (including SQL and input values) and last
preview diagnostics, flagged when stale. Its report tools read the report, list
installed components, describe a component, and stage an edit. Shared Ask AI tools
execute SQL, page cached query results, discover catalogs/tables/categories and
describe tables/functions. Governed queries support both compile-only inspection
and live execution. Component reference
comes from the pinned Core registry, including examples, attribute types/defaults,
Zod constraints, child/parent restrictions, and data-source requirements. This
avoids relying on model memory of Evidence's older Svelte syntax. Evidence also
publishes a Docs MCP (https://evidence.studio/mcp) and llms.txt/llms-full.txt,
documented at https://docs.evidence.dev/mcp/docs; this integration uses local
schemas rather than adding a dependency on that remote MCP service.

Proposals contain only editable fields: title, source, dataset SQL, parameter
definitions and input values. They pass the report/parameter schema before being
shown. Before/after review supports Apply, Discard, and Undo. Apply compares the
current report identity, service and editable content to the proposal's snapshot;
a manual edit invalidates the proposal instead of being overwritten. Saving alone
does not invalidate it. Applying changes updates the draft, not storage or preview.
Apply and preview runs the normal compiler/render validation and Haybarn queries;
Save persists the result. Subsequent agent turns receive updated errors.

SQL tools use the existing shared engine, with a result cache scoped to the report
conversation. New conversation clears that cache. Standalone SQL does not expand
report parameters or named-query references. Queries have a 60-second timeout; Stop
aborts the agent request and its active query, not unrelated engine queries.
Semantic-only mode hides and rejects raw SQL execution. The agent has no arbitrary
JavaScript execution, save or publication tools; report edits remain proposals.
Compared with main Ask AI, interactive ask_user buttons and standalone render_chart
are not exposed; reports use conversational questions and Evidence chart components.

Validation: `tests/unit/evidence-agent.test.ts` covers proposal scoping, typed
validation and stale-write protection; `tests/evidence-agent.spec.ts` uses Chrome
and mocked Anthropic SSE to exercise actual tool dispatch, installed reference,
review/apply/discard/undo, preview execution, mode persistence, missing settings,
cancellation and API errors. These transport tests do not measure live model output
quality.

### Worker-scoped local collections

Each worker URL has its own saved Evidence reports. Storage keys are
`cupola.evidence.report.v2:<encoded worker URL>:<encoded report ID>`. The library,
report lookup (including direct links and back navigation), deletion, and counts
are scoped to the active worker URL. Switching workers resets the workspace.
URLs use the application's exact service URL identity, including paths and query
strings. Multiple reports per worker are supported; matching report IDs on other
workers remain independent.

Previous `cupola.evidence.report.v2:<encoded-worker-url>:<encoded-report-id>` records remain readable on their saved
worker. Saving writes the new key before removing the matching legacy record,
so a failed write preserves the old report. Storage remains local to this browser
and Cupola origin; it is not shared with other browsers or users.

### Conversational report editing

Editing opens Chat by default; Code, Data and Parameters remain available. The
chat transcript owns each proposal and retains its applied/discarded/superseded/
undone status across follow-ups and View/Edit switches. These decisions are also
included in subsequent model context. Apply and preview changes the draft and
refreshes the existing preview in one action; it reveals the preview if hidden.
Save remains explicit. Undo is available on the latest applied proposal, including
via “undo that change” in chat, and refreshes the restored draft. New manual edits
prevent an unsafe undo. Generation can be stopped independently of preview SQL.
The chat follows new messages when scrolled near the bottom and lets readers stay
on earlier messages when they scroll up. Conversations remain session-only.

Clarification questions retain the pending proposal; only a new proposal supersedes it.
Live verification with the configured Anthropic model successfully produced a
title-only proposal and revised it in response to a follow-up. Both were left
unapplied, and the final proposal was discarded.

### Shared Ask AI presentation and request recovery

Evidence chat reuses `ChatMessageUser`, `ChatMessageAssistant` (ordered text and
expandable tool calls), `ThinkingIndicator` (elapsed time and cancel), `ChatInput`,
shared tool labels, and the existing agent/HTTP retry implementation. Report
proposals and Apply/Undo remain specific to Evidence. No model configuration is
shown in the report editor.

Optional transport progress callbacks distinguish connecting, accepted requests,
generation, and streamed tool arguments without exposing reasoning contents.
Evidence shows the actual number of received tool-input characters and warns
when no new activity arrives for 30 seconds. Network/retry status stays visible
above the composer. Errors explain that the request did not apply changes and
provide a Retry action; partial replies and completed proposals remain visible.
Retry restores the model history from before the failed turn, includes the latest
report/diagnostics, and does not duplicate the user's chat bubble. The shared
stream reader rejects provider error events and incomplete responses before any
staged tool calls execute.

Keep-alive signals and actual reply/edit output are tracked separately. After 30
seconds without output, chat explains the wait even when the connection remains
active. Stopping a request exposes Retry using the same pre-turn history and the
current draft; reasoning effort continues to come from Settings.

Live one-parameter check: in an isolated Chrome context, the agent removed
`comparison_city`, retained the bound `city` input, and replaced the removed SQL
parameter with a fixed San Francisco comparison location. Apply and preview
rendered successfully with one input, zero reported errors, and the same Haybarn
worker. The test saved no reports and did not change the user's active report.

### Data inspection and editor layout

The desktop report/editor divider supports pointer dragging and arrow keys, with
Home/End bounds and double-click reset. The preferred editor percentage is kept
in browser storage. Narrow screens keep the stacked layout; focus and viewer
modes preserve the split preference. Query activity is no longer displayed.

Browse data uses the active renderer's public inline-query registry and Evidence's
own interpolation to resolve dependent queries and current filters. The adapter
binds the last run's report parameters through the existing Haybarn engine. It
also discovers noninternal tables and views through DuckDB metadata, including
Dataset SQL's temporary tables. These are labeled as connection tables because
the shared engine may contain tables created outside this report.

Preview rows executes a SELECT wrapper capped at 101 rows (100 shown, one for
truncation detection), displays column types even for empty results, and surfaces
errors inline. No COUNT or complete result download is required. Update data
reruns Dataset SQL and the report with the current draft; stale drafts disable row
preview until updated. Changing datasets/runs discards old results, and late
responses from disposed previews are ignored. No additional WASM instance is
created. The existing query-result table component is reused for row display.

### Primary reporting surface, appearance, semantics and pivots

Reports now opens Evidence; the separate Evidence lab tab is removed. Existing
/evidence URLs remain aliases, and canonical report/library paths are /reports
and /reports/saved. Navigation retains the worker URL. SQL and semantic query
promotion events open Evidence drafts. The legacy block workspace is no longer
mounted by CatalogApp; its reusable semantic compiler, builder, parameter logic,
units and Perspective loader remain shared infrastructure.

Appearance is optional report metadata for compatibility with saved drafts.
Presets are Match Cupola, Financial paper, Ocean and Forest, with light/dark/app
mode, palettes, accent, font families and spacing. A Svelte store updates Core's
theme context independently of ReportRun. Scoped theme CSS and report-surface
variables leave editor chrome alone. Both Core mode variants receive the resolved
report mode so its global mode watcher cannot override per-report appearance.
Theme edits require Save to persist but never a dataset refresh.

Semantic datasets retain the original semantic request, not only generated SQL.
The Model tab reuses ReportSemanticDatasetBuilder (including filters, relationships,
inputs and formulas). Refresh resolves report parameter references, compiles using
VGI metadata, materializes through queryPrepared, and exposes stable dataset names
to Evidence as SQL-file entries. Owned temporary tables are replaced on refresh.
Names conflicting with report SQL fences are rejected. Compiler units, warnings
and model fingerprints remain available for inspection and acceptance. Browser
column headers use semantic labels and units. The agent can discover catalogs,
describe sources, compile semantic queries without executing them, and propose
semantic datasets, themes and pivot configurations. Semantic-only settings block
agent changes to raw SQL while allowing governed definitions.

Browse data's Explore pivot uses the existing Perspective static Arrow loader.
It retrieves at most 10,001 rows and refuses datasets exceeding 10,000 rather than
silently computing totals on a partial sample. Readers can regroup, split, filter
and change aggregates. Add pivot to report appends a live exploration section;
authors' configurations save with the report, while reader-only adjustments are
session-local. This is interactive exploration of the refreshed snapshot, not a
streaming subscription. For nonadditive semantic measures, changing grain should
recompile the semantic query rather than summing already-aggregated values.

### Expanded tables

Cupola resolves Core's table fullscreen wrapper to a native dialog inside the
report shadow root. The browser top layer keeps the table above scroll containers
and focus mode while preserving report styles. Closing or pressing Escape restores
focus to the expand control; Escape leaves report focus mode active. Theme tokens
also apply to the inner renderer root so Core's default dark colors cannot override
a report's chosen palette.

### Browser printing

Print report opens the browser's print / Save as PDF dialog. Native browser print
shortcuts use the same layout while a report is active. The report title and
applied parameter values accompany the current preview; unapplied draft changes
are labelled. Sidebar, toolbars, parameter controls and editor are omitted.

Printing captures the current view: selected tabs, expanded groups and selected
table pages. It does not fetch additional rows or expand interactive Perspective
views. Table row counts remain visible. Authors can use Evidence's `print_group`
and `print_break` options for additional control over page breaks.

The print handler releases the app's constrained ancestor layout for natural
pagination, and freezes rendered chart canvases before the print reflow. Hidden
previews in full-screen editor mode retain their last rendered chart images.
Print styles are also injected into the Evidence shadow root. Native
`afterprint` restores the document title and removes temporary print state.
`tests/evidence-print.spec.ts` checks the print layout, PDF pagination, applied
parameters, chart snapshots, editor restoration and inactive-tab isolation.

### Stopping refreshes and query deadlines

Stop refresh is available during dataset setup and while the renderer is querying.
It cancels the current report run, skips its queued queries, and ignores late
results. Refresh again starts a fresh run and query cache. Leaving the preview
also cancels its queries.

Every Evidence query has a 60-second execution limit, including dataset setup,
semantic materialization, component queries, Browse data, and pivots. Queue wait
is excluded. Timeout errors are displayed in the report or setup error panel.
The shared connection serializes queries so cancelling a queued report request
cannot interrupt another surface's active query. After interruption, the queue
waits for the engine to settle before starting subsequent work. Cancellation is
cooperative through Haybarn; it does not destroy or restart the worker.

`tests/unit/query-execution.test.ts` checks cancellation ownership, deadlines,
queue draining and recovery. `tests/evidence-refresh.spec.ts` exercises Stop,
timeouts and recovery with actual long-running SQL on the shared worker.

Haybarn rc6's pending cancellation does not interrupt parallel background tasks.
Interruptible report queries temporarily use one execution thread; the prior
thread setting is restored before other queued work runs. Parameter values are
still bound through prepared statements into private, per-query session variables
and removed afterward. DuckDB's tokenizer substitutes only parameter tokens with
constant variable references for pending execution. Safe integer inputs are bound
as BIGINT. This workaround can reduce parallel report throughput; a native Haybarn
interrupt fix would allow removing the thread restriction.
