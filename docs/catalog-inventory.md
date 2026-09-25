# Session catalog inventory

`catalog-store.ts` owns one `CatalogInventory` for the browser's DuckDB session.
The sidebar, Ask AI (chat, editor, and shell), and report discovery and semantic
compilation consume it. `list_catalogs` reads this inventory; it does not open a
second connection or assume that the service in the page URL is the only source.

Startup still uses `fetchCatalog(serviceUrl)` over VGI RPC to obtain the initial
catalog name and connection metadata before DuckDB is available. That catalog is
provisional. After engine initialization, `duckdb_databases()` determines catalog
membership. All database types are included, including `memory`, VGI, and native
DuckDB attachments; DuckDB's internal `system` and `temp` catalogs are excluded.
The metadata loader reads DuckDB's schema, table, view, column, function, and
constraint metadata plus `vgi_function_arguments()` when available. VGI tags,
including documentation and semantic tags, are preserved.

Both ordinary and prepared engine queries invalidate the inventory after
catalog-changing SQL, including multi-statement batches and failed batches that
may have partially succeeded. Background refreshes are coalesced; discovery
tools await the latest inventory before answering. Attachments made in shell,
editor, AI SQL, and report setup therefore follow the same path. Manual refresh
retries metadata reads. These are session attachments, not saved connections
that are automatically restored after a page reload.

A metadata failure leaves the catalog visible with an error and a retry action.
`list_catalogs` includes `metadata_error`; tools requiring that catalog's metadata
return an error rather than treating it as empty. A failure enumerating databases
preserves the last visible snapshot but blocks discovery until a successful
refresh. Raw SQL and non-discovery tools remain usable. Attachment identity is
tracked using `database_oid` so reusing an alias cannot inherit old metadata or
the original service URL. Detaching the primary removes it just like any other
catalog.
