import { useMemo, useState } from "react";
import { Table2, Copy, Check, Key, Link2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { TableInfo } from "vgi/client";
import { getColumns, getForeignKeys, type ForeignKeyInfo } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { ColumnsTable } from "./ColumnsTable";
import { DataPreview } from "./DataPreview";

interface Props {
  table: TableInfo;
  catalogName: string;
  onNavigate?: (selection: Selection) => void;
}

export function TableDetail({ table, catalogName, onNavigate }: Props) {
  const columns = getColumns(table);
  const foreignKeys = getForeignKeys(table);
  const sampleSql = `SELECT * FROM ${catalogName}.${table.schemaName}.${table.name} LIMIT 10;`;
  const [copied, setCopied] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

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
        <Table2 className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold font-mono text-primary">{table.name}</h1>
        <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700">table</Badge>
      </div>
      {table.comment && (
        <p className="text-muted-foreground mb-3">{table.comment}</p>
      )}

      {/* FK/constraint chips */}
      {hasConstraints && (
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
              <span className="font-medium">PK</span>
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
          {table.checkConstraints.map((chk, i) => (
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
      )}

      {/* Tabs: Schema | Data */}
      <Tabs
        defaultValue="schema"
        onValueChange={(val) => {
          if (val === "data" && !dataLoaded) setDataLoaded(true);
        }}
      >
        <TabsList className="border border-border bg-card shadow-sm h-9 p-1 gap-1">
          <TabsTrigger value="schema" className="data-active:bg-primary data-active:text-primary-foreground rounded-md px-3">
            Schema
            <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">{columns.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="data" className="data-active:bg-primary data-active:text-primary-foreground rounded-md px-3">
            Data
          </TabsTrigger>
        </TabsList>

        {/* Schema Tab */}
        <TabsContent value="schema" className="mt-4">
          {/* Sample SQL bar */}
          <div className="flex items-center gap-2 bg-muted/60 rounded-md px-3 py-2 mb-4">
            <code className="flex-1 text-xs font-mono text-muted-foreground truncate">{sampleSql}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-6 px-2 text-xs shrink-0"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>

          <ColumnsTable
            columns={columns}
            pkColumns={pkColumns}
            notNullSet={notNullSet}
            fkByColumn={fkByColumn}
            onNavigate={onNavigate}
          />
        </TabsContent>

        {/* Data Tab — lazy loaded */}
        <TabsContent value="data" className="mt-4">
          {dataLoaded && (
            <DataPreview
              catalogName={catalogName}
              functionName={table.name}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
