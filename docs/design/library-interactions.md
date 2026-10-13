# Library interactions

Cupola's Library stores reports, queries, and notebooks locally or on workers. The sidebar is quick navigation; the Library page adds cross-library search, descriptions, tags, type filters, and organization. Both use the same creation choices and respect worker capabilities. Routes keep `/reports` for compatibility.

## Editing and saving

Run remains the primary editor action. A compact Save control belongs in the existing query toolbar or notebook header. Cmd/Ctrl-S invokes the same operation. First save asks for a name and destination. Later saves update that document. Save a copy asks for a new name and destination and leaves the original open. Copy completion must identify the new copy.

Save state is derived from the current content and acknowledged revision: Local draft, Changes to save, Saving, Saved, Read-only, Save failed, or Save unconfirmed. A successful save never marks edits made during that save as saved. A browser recovery draft is distinct from a saved library document. Keep the destination visible; expose error details and exact-request retry through the status control.

The destination picker is temporary and does not push SQL or results down the page. Enter submits its form. Details, version history, sharing, and ownership are normal navigable pages. Run history is labeled separately from saved version history. Library documents use one title/navigation header.

## Reopening and conflicts

A fresh worker response replaces an unchanged browser recovery draft when a newer revision exists. Unsaved edits or an unconfirmed mutation prevent replacement. Show a comparison of the current draft and latest saved version, with explicit choices to keep a copy or load the latest version. Preserve a usable local recovery copy before replacing edited content. Never silently rebase edits onto another author's revision. Read permissions and edit availability come from the fresh response.

An interrupted mutation keeps its original request ID, worker, authentication scope, and payload. Retry that exact request before issuing another mutation. A refused request must not leave its old worker selected for a later save to a different destination.

## Execution and sources

Saved queries execute only when requested, in a connection retained for the open document. Temporary tables and `USE` state survive successive runs. Closing or resetting the session clears that state; changing source declarations, default context, or setup SQL starts a new connection. Ordinary content revisions do not reset it.

Data sources are explicit and reviewable. The default catalog is required. Other captured connections begin optional so an unrelated disconnected catalog cannot block a query. Authors can include/remove connections, mark dependencies required, and explicitly replace a connection identity. An attached alias with the wrong worker or catalog must never be silently accepted. Choosing local memory clears the default schema.

## Capability boundaries

Scheduling and email actions apply to reports. Query and notebook URLs requesting scheduling explain that boundary rather than rendering an empty page. Creation choices are limited by both the worker's accepted formats and the selected folder's allowed kinds/actions. A read-only worker does not prevent local work.

## Regression journeys

Cover create → save → edit → reopen → share for queries and notebooks; clean newer revisions; concurrent edits; exact-request replay after a lost response; read-only saves; failed destination changes; edits during a save; default source changes; retained SQL temporary tables; keyboard submission; and narrow Chromium/WebKit layouts. Use isolated workers and databases; never send email from these UI tests.
