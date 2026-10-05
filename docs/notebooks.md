# SQL notebooks

Open **Notebooks** in the workspace tab bar, or visit `/notebooks?service=…` under the application's versioned base URL. A notebook belongs to the current connection and combines SQL cells, Markdown, and charts attached to SQL results.

## Authoring and execution

- Add SQL or Markdown cells, rename them, collapse them, duplicate them, or move them up and down. Delete is reversible with Undo. The document history keeps up to 100 edits; text editors retain their own keyboard undo.
- Each SQL cell accepts one SELECT query, including WITH, FROM, and VALUES forms. DuckDB parses the SQL before execution to reject other statement types, including writes prefixed by WITH. Cells are independent: a cell's display name does not create a SQL view or table. Scripts and changes to data belong in the Query Editor.
- **Run**, Cmd/Ctrl+Enter, or Shift+Enter executes one SQL cell. **Run all** executes SQL cells in document order and stops at the first error. **Run changed** executes cells without a successful current result. **Stop** and **Stop all** cancel through the existing engine's AbortSignal path.
- SQL edits do not execute queries. The prior result stays visible and is marked stale. Failures and cancellation preserve the last successful result with its timestamp. Editing during a run is allowed: a result is attributed to the exact SQL submitted, so subsequent edits remain stale.
- Charts and tables share the same returned Arrow table. A successful run replaces that result for every attached view. Opening a saved notebook never automatically runs SQL.

## Tables and charts

The table uses the Query Editor's results pane, including result formatting, fullscreen viewing, and CSV, Arrow, and Excel downloads. **+ Chart** adds a named output tab. Supported chart types are bar, line, area, scatter, and histogram, with X/Y columns, color grouping, axis labels, X sorting, and number formatting.

Chart changes render the current result without executing SQL. Histograms explicitly bin and count returned values; other aggregations should be expressed in SQL. A missing or incompatible column produces a configuration error so it can be replaced in the chart editor. PNG and SVG downloads use the existing chart renderer.

Charts convert and render at most 10,000 returned rows. Larger results display a visible preview warning; aggregate or filter in SQL to produce a complete chart. The table and its downloads retain the full returned result. The row count describes the returned query result, which can itself be limited by SQL or the connected service.

## Saving and sharing

Notebook definitions autosave after a short idle period to browser storage, separately for each connection. **Save** or Cmd/Ctrl+S saves immediately. Storage errors remain visible and Export remains available. Concurrent changes from another browser tab block overwriting that version; export your edits before reopening the notebook.

**Export** downloads a versioned `.notebook.json` definition. It contains SQL, Markdown, chart settings, and the connection reference, but no result data or application credentials. **Import notebook** validates the file and creates a new notebook on the current connection without executing it. SQL may need adjustment when importing into a different catalog. Only share definitions whose SQL and prose are appropriate for the recipient.

The library supports search and deletion with confirmation. Unsupported or corrupt saved records are reported and preserved. Notebook definitions are limited to 200 cells, with up to 20 charts per SQL cell; imports are limited to 5 MB.

## AI assistant

**Ask AI** uses Cupola's existing model settings, catalog discovery, query tools, and query access mode. It can inspect schemas, explore data with read queries, and propose SQL, Markdown, chart, or document changes. Proposals are reviewed before applying, never execute notebook cells automatically, and are reversible through Undo. A proposal cannot be applied if the document has changed since it was generated. In semantic-only mode, the assistant cannot create or change raw SQL cells.

## Implementation

- `src/lib/notebooks/model.ts`: versioned document validation, identities, import/export model, and storage.
- `src/lib/notebooks/execution.ts`: ordered execution, cancellation, and result freshness, independent of React.
- `src/lib/notebooks/charts.ts`: bounded Arrow conversion, column validation, and Vega-Lite generation.
- `src/lib/notebooks/agent.ts`: AI tools and optimistic proposal validation.
- `src/components/notebooks/`: library, workspace, cell editor, chart configuration, and assistant.

The workspace is lazy-loaded and remains mounted across top-level tab switches. It reuses the existing Haybarn connection, CodeMirror editor, results pane, chart renderer, and AI transport. It introduces no notebook framework or database dependency. JavaScript/Python cells, SQL-to-SQL cell references, automatic query reruns, server-backed storage, and collaborative editing are outside this version.

Validation: `bun test tests/unit/notebooks.test.ts`, `bunx playwright test tests/notebooks.spec.ts`, and `bun run check`. Browser tests require the VGI test service from `test-worker/run.sh`.
