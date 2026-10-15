# Library interactions

Cupola's Reports overview lists only reports stored locally or on workers. It adds cross-library report search, a direct New report action, and access to schedules. Its search results exclude queries and notebooks; it has no document-type selector.

The sidebar Library is the primary place to organize all saved object types. It supports folders, name and description search, and context-menu actions. Opening a local or worker folder shows all its contents, with type filters and creation choices that respect worker capabilities. The Reports tab returns from a folder listing to the report-only overview. Queries and notebooks open in their ordinary editors. Routes keep `/reports` for compatibility.

## Editing and saving

Run remains the primary editor action. A compact Save control belongs in the existing query toolbar or notebook header. Cmd/Ctrl-S invokes the same operation. First save asks for a name and destination. Later saves update that document. Save a copy asks for a new name and destination and leaves the original open. Copy completion must identify the new copy.

Save state is derived from the current content and acknowledged revision: Local draft, Changes to save, Saving, Saved, Read-only, Save failed, or Save unconfirmed. A successful save never marks edits made during that save as saved. A browser recovery draft is distinct from a saved library document. Keep the destination visible; expose error details and exact-request retry through the status control.

The destination picker is temporary and does not push SQL or results down the page. Enter submits its form. Details, version history, sharing, and ownership are normal navigable pages. Run history is labeled separately from saved version history. Library documents use their ordinary editors. Saved queries open beside scratch queries in the Query Editor tab strip; reopening the same worker, identity and revision focuses its existing tab. Double-click, F2, or the tab context menu renames a query; Save commits that title with the query. Saved notebooks open in Notebooks with the normal editable title and navigation. Storage location does not choose a different editing surface.

Closing a saved query tab leaves the library object intact. An unsaved edit prompts before closing and remains recoverable when the query is reopened. Worker locations, authenticated identities, and explicitly pinned revisions have distinct draft identities. Switching query tabs preserves query results and execution sessions. Legacy library document URLs still open the appropriate editor; management pages stay in the current workspace.

Opening query version history uses in-app navigation. The query editor, unsaved SQL, results, and execution session survive Back to document and browser Back/Forward. Management pages request the mounted editor's current save state before enabling actions that could replace a draft.

## Reopening and conflicts

A fresh worker response replaces an unchanged browser recovery draft when a newer revision exists. Unsaved edits or an unconfirmed mutation prevent replacement. Show a comparison of the current draft and latest saved version, with explicit choices to keep a copy or load the latest version. Preserve a usable local recovery copy before replacing edited content. Never silently rebase edits onto another author's revision. Read permissions and edit availability come from the fresh response.

An interrupted mutation keeps its original request ID, worker, authentication scope, and payload. Retry that exact request before issuing another mutation. A refused request must not leave its old worker selected for a later save to a different destination.

Workers decide name uniqueness. When a worker refuses a duplicate name, show its message inside the destination form and keep that form editable for correction. A normal Save on an already bound document does not open the destination picker; errors appear through Save status and leave the draft intact.

The sidebar's Delete action is available when the worker permits deletion. Confirmation names the document and library; version checks protect concurrent changes, and an uncertain response retries the original request. Deletion removes the saved object but retains open query/notebook drafts for Save a copy. Completed moves and copies close their dialog, navigate to the destination, and refresh the listing without an additional success banner. Errors and unconfirmed transfers remain visible.

## Finding objects and schedules

The sidebar, folder listings, and Reports overview use a single search field matching names and descriptions. The sidebar searches every object type; the Reports overview searches reports across libraries, including reports in nested folders. Descriptions are optional and editable in document details. Cupola has no tag chips, tag filters, or tag editing fields. Existing tags remain in stored metadata and are preserved when editing details, saving, or transferring documents.

Library shows a Scheduled reports entry when connected workers have report schedules the current user can access, including paused schedules. It opens Schedules & alerts across all workers. The sidebar and activity page share discovery and refresh after schedule changes, sidebar refresh, and periodic polling; the entry disappears when no accessible report schedules remain. Workers without scheduling support do not get an empty entry.

Schedules & alerts defaults to all report schedules the current user can access. Its worker selector narrows the list, and Needs attention remains a separate filter. The same page is reachable from a worker's sidebar context menu, initially filtered to that worker, or from the main listing for all connected workers. These alerts concern schedule health. Advanced schedule settings also accept a SQL condition for conditional report delivery; stateful SQL data-alert rules are not yet implemented.

## Execution and sources

Saved queries execute only when requested, in a connection retained for the open document. Temporary tables and `USE` state survive successive runs. Closing or resetting the session clears that state; changing source declarations, default context, or setup SQL starts a new connection. Ordinary content revisions do not reset it.

Data sources are explicit and reviewable. The default catalog is required. Other captured connections begin optional so an unrelated disconnected catalog cannot block a query. Authors can include/remove connections, mark dependencies required, and explicitly replace a connection identity. An attached alias with the wrong worker or catalog must never be silently accepted. Choosing local memory clears the default schema.

## Capability boundaries

Scheduling and email actions apply to reports. Query and notebook URLs requesting scheduling explain that boundary rather than rendering an empty page. Creation choices are limited by both the worker's accepted formats and the selected folder's allowed kinds/actions. A read-only worker does not prevent local work.

## Regression journeys

Cover create → save → edit → reopen → share for queries and notebooks; clean newer revisions; concurrent edits; exact-request replay after a lost response; read-only saves; failed destination changes; edits during a save; default source changes; retained SQL temporary tables; keyboard submission; tab reuse and same-ID isolation across workers/accounts/revisions; tab rename and close/reopen recovery; notebook title editing; and narrow Chromium/WebKit layouts. Use isolated workers and databases; never send email from these UI tests.
