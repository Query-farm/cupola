# SQL notebooks

Open **Notebooks** in the workspace tab bar, or visit `/notebooks?service=…` under the application's versioned base URL. A notebook belongs to the current connection and combines SQL cells, Markdown, and charts attached to SQL results.

The sidebar lists browser-saved notebooks for the current workspace under **On this device → Notebooks**. Click **Notebooks** to open the library, its arrow to expand or collapse the list, or **+** to create a local notebook. Right-click a saved notebook or use its **⋯** button to rename, duplicate, export, or delete it. Shift+F10 opens the same menu from a focused notebook link. Deletion requires confirmation; stop running queries or an AI response before deleting the open notebook. Actions on an open notebook use its current edits.

## Authoring and execution

- Add SQL or Markdown cells, rename them, collapse them, duplicate them, or move them up and down. Delete is reversible with Undo. The document history keeps up to 100 edits; text editors retain their own keyboard undo.
- Use **Hide code** / **Show code** in a SQL cell's header to display just its output or restore its editor. This setting is saved with the notebook and does not change or rerun the SQL. The cell menu also offers separate controls for hiding output or collapsing the entire cell.
- Catalog paste actions target the selected SQL cell, revealing its editor when needed. Without a selected SQL cell, insertion uses the first SQL cell or creates one. Inserting from the notebook library creates a notebook. Tables inserted into an empty cell expand into a SELECT; function snippets support Tab through arguments, and columns use quoted identifiers. Drag catalog entries directly into a SQL editor to insert them at the drop position.
- Each SQL cell accepts one SELECT query, including WITH, FROM, and VALUES forms, or `CREATE [OR REPLACE] TEMP TABLE name AS` followed by one such query. DuckDB parses the query before execution to reject other statement types, including writes prefixed by WITH. A cell's display name does not create a SQL view or table. Scripts and changes to stored data belong in the Query Editor.
- **Run**, Cmd/Ctrl+Enter, or Shift+Enter executes one SQL cell. **Run all** executes SQL cells in document order and stops at the first error. **Run changed** executes cells without a successful current result. **Stop** and **Stop all** cancel through the existing engine's AbortSignal path.
- SQL and referenced parameter edits do not execute queries. The prior result stays visible and is marked stale. Changes to preceding temporary-table cells and their parameters also mark downstream results stale; successful table replacements invalidate later cells even when their SQL is unchanged. **Run changed** conservatively includes these affected cells. Failures and cancellation preserve the last successful result with its timestamp. Editing during a run is allowed: the whole batch captures its SQL and parameter values before execution, so subsequent edits remain stale. Changes in the underlying remote data are not monitored by **Run changed**.
- Charts and tables share the same returned Arrow table. A successful run replaces that result for every attached view. Opening a saved notebook never automatically runs SQL.

## Parameters

Use **Add parameters** above the cells to define text, number, date, dropdown, or checkbox widgets. Each has a SQL name, display label, default value, and optional required setting; dropdowns also have a list of choices. Reference values with unquoted names such as `SELECT * FROM sales WHERE region = $region`. Parameter names appear in SQL completion. Values use prepared query bindings, so quotes in text remain data. References inside quoted SQL text or comments are left untouched.

Widgets store their current values with the notebook. **Reset to defaults** clears these overrides. Only parameters referenced by a cell are validated for its execution. Freshness also includes parameter values used by preceding temporary-table cells. **Run changed** refreshes affected cells; changing a widget never runs SQL automatically. Notebook definitions support up to 50 parameters.

## Sharing data between cells

Create a temporary table in one cell:

```sql
CREATE OR REPLACE TEMP TABLE regional_sales AS
SELECT region, sum(amount) AS total
FROM my_catalog.main.sales
GROUP BY region;
```

Then query it from another cell:

```sql
SELECT * FROM regional_sales WHERE total > 1000;
```

The creating cell displays the materialized rows, which also support charts and downloads. `OR REPLACE` makes repeated runs rebuild the table. Parameters work in the creating query just as they do in SELECT cells. Use `temp.main.regional_sales` to explicitly refer to the temporary table if an attached catalog has the same name. Only unqualified table names are accepted in the CREATE statement; quoted names are supported.

Run creating cells before their consumers, or use **Run all**. There is no automatic execution or dependency reordering. A replacement runs in a transaction: errors and cancellation roll back to the previous table. **Explain query** plans the statement without creating or replacing its table. Editing or deleting a cell does not drop its table; the session retains the last successfully created tables until reset or closed. Temporary views, persistent CREATE, DML, and SET statements are not supported in notebook cells.

Each open notebook owns a separate connection to the same WASM engine. Attached catalogs are shared; temporary tables and parameter-binding variables are connection-local and unavailable to other notebooks or the Query Editor. Switching notebooks, returning to the notebook library, reloading, changing workspaces/connections, or deleting the open notebook closes its session. Reopening starts empty: use **Run all** to rebuild. Switching top-level workspace tabs keeps the open notebook session alive.

**Notebook actions → Reset session** closes the connection and clears temporary tables, results, plans, pins, and the assistant conversation, without changing saved SQL or widget values. **Clear all outputs** and a cell's **Clear output** remove displayed results only; temporary tables remain. Tables are never included in notebook exports.

## Execution and provenance

While a cell runs, its border and status are highlighted with a spinner. Its status distinguishes waiting for the engine, queueing behind other queries, SQL validation, execution, and result decoding, with a live elapsed timer. Rerunning a cell with a previous result shows **Reevaluating** and keeps that output visible until the new result arrives. The status remains visible when code is hidden or the cell is collapsed. Batch runs show the current cell's position. **Stop all** cancels the current query and skips remaining cells.

**Run details** records the submitted SQL, prepared SQL and bound values, connection, notebook session, available engine version, start and finish times, total duration, returned rows, and outcome. The displayed result's provenance remains separate from the latest attempt, including a failed or cancelled rerun. **Export run details** downloads this metadata as JSON.

Choose **Explain query** from a cell's run menu to view its plan with the current parameter values. Planning has separate run metadata and does not replace the cell's query result. **Pin result** retains one successful result and its provenance in a separate output tab for comparison after a rerun; downloads from that tab use the pinned rows.

Results, plans, pins, and the last 10 attempts' metadata per cell remain in memory for the open notebook session. Closing the notebook, resetting its session or reloading clears them; export result data and run details to retain them.

## Tables and charts

The table uses the Query Editor's results pane, including result formatting, fullscreen viewing, and CSV, Arrow, and Excel downloads. **+ Chart** adds a named output tab. Supported chart types are bar, line, area, scatter, and histogram, with X/Y columns, color grouping, axis labels, X sorting, and number formatting.

Chart changes render the current result without executing SQL. Histograms explicitly bin and count returned values; other aggregations should be expressed in SQL. A missing or incompatible column produces a configuration error so it can be replaced in the chart editor. PNG and SVG downloads use the existing chart renderer.

Charts convert and render at most 10,000 returned rows. Larger results display a visible preview warning; aggregate or filter in SQL to produce a complete chart. The table and its downloads retain the full returned result. The row count describes the returned query result, which can itself be limited by SQL or the connected service.

## Saving and sharing

Notebook definitions autosave after a short idle period to browser storage, separately for each connection. **Save** or Cmd/Ctrl+S saves immediately. Storage errors remain visible and Export remains available. Concurrent changes from another browser tab block overwriting that version; export your edits before reopening the notebook.

**Export** downloads a versioned `.notebook.json` definition. It contains SQL, Markdown, chart settings, parameter definitions and saved values, and the connection reference, but no result data or application credentials. **Import notebook** validates the file and creates a new notebook on the current connection without executing it. SQL may need adjustment when importing into a different catalog. Only share definitions whose SQL, prose, and parameter values are appropriate for the recipient.

The library supports search and deletion with confirmation. Unsupported or corrupt saved records are reported and preserved. Notebook definitions are limited to 200 cells, with up to 20 charts per SQL cell; imports are limited to 5 MB.

## AI assistant

Proposed cell and parameter changes start collapsed in both the assistant and the expanded review. Click an entry's heading to inspect its details; the proposal summary and Apply changes controls stay visible.

**Ask AI** uses Cupola's existing model settings, catalog discovery, query tools, and query access mode. Its read queries run in the notebook's connection, so it can inspect temporary tables already created by cells. Its instructions explain table sharing, execution order, cleanup and reset. It can propose temporary-table setup cells and their consumers, but its query tools remain read-only: only running notebook cells creates or replaces tables. It can also explore data using notebook parameters and propose SQL, Markdown, chart, parameter, or document changes. Proposals are reviewed before applying, never execute notebook cells automatically, and are reversible through Undo. A proposal cannot be applied if the document or parameter values have changed since it was generated. In semantic-only mode, the assistant cannot create or change raw SQL cells.

## Implementation

- `src/lib/notebooks/model.ts`: versioned document validation, identities, import/export model, and storage.
- `src/lib/notebooks/execution.ts`: ordered execution, cancellation, and result freshness, independent of React.
- `src/lib/notebooks/session.ts`: notebook connection lifetime and transactional temporary-table cells.
- `src/lib/duckdb-scoped-connection.ts`: isolated connections using the engine's shared scheduler, owned cancellation, prepared bindings, transactions, and queued disconnect.
- `src/lib/notebooks/parameters.ts`: widget validation and SQL parameter binding.
- `src/lib/notebooks/charts.ts`: bounded Arrow conversion, column validation, and Vega-Lite generation.
- `src/lib/notebooks/agent.ts`: AI tools and optimistic proposal validation.
- `src/components/notebooks/`: library, workspace, cell editor, chart configuration, and assistant.

The workspace is lazy-loaded and remains mounted across top-level tab switches. It reuses the existing Haybarn engine, CodeMirror editor, results pane, chart renderer, and AI transport. Connections share a worker-level query queue because its cancellation SAB and fallback thread settings are global; cancellation targets the active connection, and closing waits for its work and rollback to settle. It introduces no notebook framework or database dependency. JavaScript/Python cells, automatic query reruns, server-backed storage, and collaborative editing are outside this version.

Validation: `bun test tests/unit/notebooks.test.ts tests/unit/notebook-session.test.ts tests/unit/notebook-parameters.test.ts tests/unit/query-execution.test.ts`, `bunx playwright test tests/notebooks.spec.ts tests/notebook-sidebar.spec.ts tests/notebook-workflow.spec.ts tests/notebook-sharing.spec.ts`, and `bun run check`. Browser tests require the VGI test service from `test-worker/run.sh`. Sharing tests exercise real WASM connections, shared attached catalogs, isolated temporary tables and variables, disconnect/reopen, cross-connection cancellation, replacement rollback, notebook switching, reset, and the assistant's access to notebook tables.
