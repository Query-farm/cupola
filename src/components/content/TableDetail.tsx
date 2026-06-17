import { useMemo, useState, useEffect } from "react";
import { Key, Link2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button"
import type { TableInfo } from "vgi/client";
import { getColumns, getForeignKeys, fetchColumnStats, type ForeignKeyInfo, type ColumnStats } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { Breadcrumb } from "./Breadcrumb";
import { ColumnsTable } from "./ColumnsTable";
import { TagsTable } from "./TagsTable";
import { ExampleQueries } from "./ExampleQueries";
import { filterDisplayTags, TAG_DESCRIPTION_MD, TAG_EXAMPLE_QUERIES } from "@/lib/tags";
import { DescriptionSection } from "./DescriptionSection";

interface Props {
  table: TableInfo;
  catalogName: string;
  onNavigate?: (selection: Selection) => void;
  onOpenShell?: () => void;
}

export function TableDetail({ table, catalogName, onNavigate, onOpenShell }: Props) {
  const columns = getColumns(table);
  const foreignKeys = getForeignKeys(table);
  const defaultSql = `SELECT * FROM ${catalogName}.${table.schema_name}.${table.name} LIMIT 10;`;
  const displayTags = useMemo(() => filterDisplayTags(table.tags), [table.tags]);

  // Lazily fetch column statistics from DuckDB WASM shell.
  // undefined = loading, Map = loaded, null = unavailable.
  // fetchColumnStats internally awaits bridge.attached, so a click that
  // lands before the shell finishes booting is queued, not failed.
  const [columnStats, setColumnStats] = useState<Map<string, ColumnStats> | undefined | null>(undefined);
  useEffect(() => {
    let cancelled = false;
    setColumnStats(undefined);
    fetchColumnStats(catalogName, table.schema_name, table.name).then(
      (stats) => { if (!cancelled) setColumnStats(stats); },
      () => { if (!cancelled) setColumnStats(null); },
    );
    return () => { cancelled = true; };
  }, [catalogName, table.schema_name, table.name]);

  // Build constraint lookup sets
  const notNullSet = new Set<number>(table.not_null_constraints);
  const pkColumns = new Set<number>((table.primary_key_constraints ?? []).flatMap((pk) => pk));

  // Build FK lookup: column name → FK info
  const fkByColumn = useMemo(() => {
    const map = new Map<string, ForeignKeyInfo>();
    for (const fk of foreignKeys) {
      for (const col of fk.columns) {
        map.set(col, fk);
      }
    }
    return map;
  }, [foreignKeys]);

  const hasConstraints =
    foreignKeys.length > 0 ||
    (table.primary_key_constraints?.length ?? 0) > 0 ||
    table.unique_constraints.length > 0 ||
    table.check_constraints.length > 0;

  return (
    <div>
      <Breadcrumb
        catalogName={catalogName}
        schemaName={table.schema_name}
        itemName={table.name}
        itemType="table"
        onNavigate={onNavigate}
        trailing={onOpenShell ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenShell}
            className="h-7 text-xs gap-1.5"
          >
            <img src={`${import.meta.env.BASE_URL}duckdb-icon-light.svg`} alt="" className="h-3.5 w-3.5" />
            Open SQL Shell
          </Button>
        ) : undefined}
      />

      {table.comment && (
        <p className="text-muted-foreground mb-3">{table.comment}</p>
      )}

      {table.tags?.[TAG_DESCRIPTION_MD] && (
        <DescriptionSection markdown={table.tags[TAG_DESCRIPTION_MD]} />
      )}

      {/* Columns */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-4 mb-2">
        Columns
        <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0 normal-case">{columns.length}</Badge>
      </h2>
      <ColumnsTable
        columns={columns}
        pkColumns={pkColumns}
        notNullSet={notNullSet}
        fkByColumn={fkByColumn}
        checkConstraints={table.check_constraints}
        columnStats={columnStats}
        catalogName={catalogName}
        schemaName={table.schema_name}
        tableName={table.name}
        onNavigate={onNavigate}
      />

      {/* References */}
      {hasConstraints && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-6 mb-2">References</h2>
          <div className="flex flex-wrap gap-2 mb-4">
            {foreignKeys.map((fk, i) => (
              <button
                key={`fk-${i}`}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border bg-card hover:border-primary/30 hover:bg-accent/5 transition-colors cursor-pointer"
                onClick={() => onNavigate?.({
                  type: "table",
                  name: fk.referencedTable,
                  schema: fk.referencedSchema,
                })}
              >
                <Link2 className="h-3 w-3 text-primary/60" />
                <span className="font-mono font-medium">{fk.columns.join(", ")}</span>
                <span className="text-muted-foreground">&rarr;</span>
                <span className="font-mono text-primary">{fk.referencedSchema}.{fk.referencedTable}</span>
              </button>
            ))}
            {(table.primary_key_constraints ?? []).map((pk, i) => (
              <span
                key={`pk-${i}`}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border bg-card"
              >
                <Key className="h-3 w-3 text-amber-500" />
                <span className="font-medium">Primary Key</span>
                <span className="font-mono text-muted-foreground">({pk.map((idx) => columns[idx]?.name ?? idx).join(", ")})</span>
              </span>
            ))}
            {table.unique_constraints.map((uq, i) => (
              <span
                key={`uq-${i}`}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border bg-card"
              >
                <ShieldCheck className="h-3 w-3 text-blue-500" />
                <span className="font-medium">UNIQUE</span>
                <span className="font-mono text-muted-foreground">({uq.map((idx) => columns[idx]?.name ?? idx).join(", ")})</span>
              </span>
            ))}
            {table.check_constraints
              .filter((chk) => {
                // Only show in References if the check references multiple columns or none
                const matchingCols = columns.filter((c) => chk.includes(c.name));
                return matchingCols.length !== 1;
              })
              .map((chk, i) => (
              <span
                key={`chk-${i}`}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border bg-card"
              >
                <ShieldCheck className="h-3 w-3 text-green-500" />
                <span className="font-medium">CHECK</span>
                <code className="text-muted-foreground">{chk}</code>
              </span>
            ))}
          </div>
        </>
      )}

      {displayTags && (
        <TagsTable tags={displayTags} />
      )}

      <ExampleQueries
        exampleQueriesJson={table.tags?.[TAG_EXAMPLE_QUERIES]}
        defaultSql={defaultSql}
        onOpenShell={onOpenShell}
      />

    </div>
  );
}
