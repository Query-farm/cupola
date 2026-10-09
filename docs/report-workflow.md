# Report authoring and sharing

**All reports** combines this browser's reports with reports from connected workers. Named locations open their folders. New reports can always start **On this device**; use **Copy to…** or **Move to…** to save them elsewhere. Workers advertising `vgi.reports.v1` provide shared folders, immutable revisions, publication, ownership and portable links; see [Worker report libraries](reporting-protocols.md). The header names the storage location and says **Saved to worker** only after the worker acknowledges a revision. Preview remains explicit.

The **On this device** library keeps reports in the current browser, separately for each data connection. Its header says **Saved in this browser** when the definition is stored; this does not mean the preview has been refreshed. These local reports do not sync across browsers or devices. The local authoring and sharing workflow is described below.

The sidebar lists browser-saved reports for the current workspace under **On this device → Reports**. Click **Reports** to open the library, its arrow to expand or collapse the list, or **+** to create a local report. Right-click a saved report or use its **⋯** button to rename, duplicate, export its editable report file, or delete it. Shift+F10 opens the same menu from a focused report link. Deletion requires confirmation; stop a refresh or wait for PDF export to finish before deleting the open report. Actions on an open report use its current edits, and report files retain revision history.

## Creating and editing

- **New report** opens the report assistant with a prompt to describe the report and data to use. Summary, Trend, and Table starters provide working layouts using clearly labeled sample data. Replace their SQL in Code or ask the assistant to use your data.
- **Code** contains Markdown, report SQL, and Evidence components. **Setup SQL** prepares tables before a refresh. **Datasets** builds semantic queries from governed measures and dimensions. **Results** inspects results and explores pivots.
- **All editing tools** lists every tool with a description, including Appearance, Parameters, Performance, and History. It is available even when some tabs are outside the visible tab strip.
- **Focus report** is available directly in the header. On screens below 1024px, Editor and Preview use separate panes, and the catalog sidebar opens as a drawer. Desktop editing retains the resizable split view.
- The Problems panel expands for errors and can be opened for details when there are no errors.
- **Update preview** (Cmd/Ctrl+Enter) applies definition changes and refreshes data. A visible message explains when the preview still represents an earlier definition.
- **History** records saved revisions and applied assistant changes. Restore brings an earlier definition back into the current report. Edits save automatically; Cmd/Ctrl+S saves immediately and starts a new revision session.
- Draft recovery keeps changes that could not be saved. It is local to the current browser and data connection.

## Filters and refresh

Filter controls stage selected values. **Apply filters** refreshes the report with them; **Reset filters** restores defaults and refreshes. The **Results use** summary always describes the values from the displayed run, including when newer selections have already been saved locally. PDF export is unavailable while definition or filter changes remain unapplied.

Before replacing temporary datasets, refresh retains a static copy of the previous rendered report. If setup fails or is stopped, that read-only preview remains with an explicit notice. Interactive embeds are represented by a placeholder; separate pivot explorations are not captured. A successful setup replaces the retained preview with the new renderer. Errors during rendering still appear in the report and Problems panel.

## Sharing

**Share** offers two download choices:

- **PDF** contains the displayed report and applied filters for recipients to read without a data connection. The selected tab of each report tab group and all table rows are exported. The existing Export PDF action remains available in View mode and under More when editing.
- **Editable report** contains the latest definition, selected filter values, and saved revision history. Recipients use **Reports → Import** and need access to the same data service to refresh it. Queries execute with their connection.

Downloaded copies do not receive later edits. The report address only resolves for a browser that already stores that report. **Export all** in the library downloads all reports for the current connection.
