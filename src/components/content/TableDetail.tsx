import { useMemo } from "react";
import { Key, Link2, ShieldCheck } from "lucide-react";
import { CatalogIcon, getBadgeColorForType } from "./CatalogIcons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button"
import type { TableInfo } from "vgi/client";
import { getColumns, getForeignKeys, type ForeignKeyInfo } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { Breadcrumb } from "./Breadcrumb";
import { ColumnsTable } from "./ColumnsTable";
import { TagsTable } from "./TagsTable";
import { ExampleQueries } from "./ExampleQueries";
import { filterDisplayTags } from "@/lib/tags";
import { DescriptionSection } from "./DescriptionSection";

interface Props {
  table: TableInfo;
  catalogName: string;
  onNavigate?: (selection: Selection) => void;
  onOpenShell?: () => void;
  shellMode?: string;
}

export function TableDetail({ table, catalogName, onNavigate, onOpenShell, shellMode }: Props) {
  const columns = getColumns(table);
  const foreignKeys = getForeignKeys(table);
  const defaultSql = `SELECT * FROM ${catalogName}.${table.schemaName}.${table.name} LIMIT 10;`;
  const displayTags = useMemo(() => filterDisplayTags(table.tags), [table.tags]);

  // Build constraint lookup sets
  const notNullSet = new Set(table.notNullConstraints);
  const pkColumns = new Set(table.primaryKeyConstraints.flatMap((pk) => pk));

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

  function handleCopy() {
    navigator.clipboard.writeText(sampleSql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  const hasConstraints =
    foreignKeys.length > 0 ||
    table.primaryKeyConstraints.length > 0 ||
    table.uniqueConstraints.length > 0 ||
    table.checkConstraints.length > 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <CatalogIcon type="table" className="h-6 w-6" />
        <h1 className="text-2xl font-bold font-mono text-primary">{table.name}</h1>
        <Badge variant="secondary" className={`text-xs ${getBadgeColorForType("table")}`}>table</Badge>
        {onOpenShell && (shellMode === "minimized" || !shellMode) && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenShell}
            className="ml-auto h-7 text-xs gap-1.5"
          >
            <img src="/duckdb-icon-light.svg" alt="" className="h-3.5 w-3.5" />
            Open SQL Shell
          </Button>
        )}
      </div>

      <Breadcrumb catalogName={catalogName} schemaName={table.schemaName} itemName={table.name} itemType="table" onNavigate={onNavigate} />

      {table.comment && (
        <p className="text-muted-foreground mb-3">{table.comment}</p>
      )}

      {table.tags?.description_md && (
        <DescriptionSection markdown={table.tags.description_md} />
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
        checkConstraints={table.checkConstraints}
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
            {table.primaryKeyConstraints.map((pk, i) => (
              <span
                key={`pk-${i}`}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border bg-card"
              >
                <Key className="h-3 w-3 text-amber-500" />
                <span className="font-medium">Primary Key</span>
                <span className="font-mono text-muted-foreground">({pk.map((idx) => columns[idx]?.name ?? idx).join(", ")})</span>
              </span>
            ))}
            {table.uniqueConstraints.map((uq, i) => (
              <span
                key={`uq-${i}`}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border bg-card"
              >
                <ShieldCheck className="h-3 w-3 text-blue-500" />
                <span className="font-medium">UNIQUE</span>
                <span className="font-mono text-muted-foreground">({uq.map((idx) => columns[idx]?.name ?? idx).join(", ")})</span>
              </span>
            ))}
            {table.checkConstraints
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
        exampleQueriesJson={table.tags?.example_queries}
        defaultSql={defaultSql}
        onOpenShell={onOpenShell}
      />

    </div>
  );
}
