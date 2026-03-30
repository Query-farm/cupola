import { useState } from "react";
import { Table2, Copy, Check, Key, Link2, ShieldCheck, Circle, CircleDot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSettings } from "@/lib/settings";
import type { TableInfo } from "vgi/client";
import { getColumns, getForeignKeys } from "@/lib/service";
import type { Selection } from "@/lib/tree";

interface Props {
  table: TableInfo;
  catalogName: string;
  onNavigate?: (selection: Selection) => void;
}

export function TableDetail({ table, catalogName, onNavigate }: Props) {
  const columns = getColumns(table);
  const foreignKeys = getForeignKeys(table);
  const { settings } = useSettings();
  const sampleSql = `SELECT * FROM ${catalogName}.${table.schemaName}.${table.name} LIMIT 10;`;
  const [copied, setCopied] = useState(false);

  // Build constraint lookup sets
  const notNullSet = new Set(table.notNullConstraints);
  const pkColumns = new Set(
    table.primaryKeyConstraints.flatMap((pk) => pk)
  );

  function handleCopy() {
    navigator.clipboard.writeText(sampleSql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <Table2 className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold font-mono text-primary">{table.name}</h1>
        <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700">table</Badge>
      </div>
      {table.comment && (
        <p className="text-muted-foreground mb-6">{table.comment}</p>
      )}

      {/* Columns */}
      {columns.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Columns ({columns.length})
          </h2>
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs w-[30%]">Name</TableHead>
                  <TableHead className="text-xs w-[20%]">Type</TableHead>
                  <TableHead className="text-xs w-[10%]">Nullable</TableHead>
                  <TableHead className="text-xs w-[40%]">Comment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {columns.map((col, idx) => (
                  <TableRow key={col.name}>
                    <TableCell className="font-mono text-sm font-medium py-2">
                      <span className="flex items-center gap-1.5">
                        {col.name}
                        {pkColumns.has(idx) && (
                          <Key className="h-3 w-3 text-amber-500" title="Primary key" />
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground py-2">
                      {settings.showDuckDBTypes ? col.duckdbType : col.arrowType}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground py-2">
                      {notNullSet.has(idx) ? (
                        <span className="flex items-center gap-1" title="NOT NULL constraint">
                          <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
                          <span className="text-foreground font-medium text-xs">NOT NULL</span>
                        </span>
                      ) : col.nullable ? (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground/50" title="Nullable" />
                      ) : (
                        <CircleDot className="h-3.5 w-3.5 text-foreground/70" title="Not nullable" />
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground py-2">
                      {col.comment && (
                        <span className="text-foreground/80">{col.comment}</span>
                      )}
                      {col.defaultValue && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          default: <code className="bg-muted px-1 rounded">{col.defaultValue}</code>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Constraints */}
      {(table.primaryKeyConstraints.length > 0 ||
        table.uniqueConstraints.length > 0 ||
        table.checkConstraints.length > 0) && (
        <>
          <Separator className="my-6" />
          <div className="mb-8">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              Constraints
            </h2>
            <div className="space-y-2">
              {table.primaryKeyConstraints.map((pk, i) => (
                <div key={`pk-${i}`} className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-card text-sm">
                  <Key className="h-4 w-4 text-amber-500 shrink-0" />
                  <Badge variant="outline" className="text-xs shrink-0">PRIMARY KEY</Badge>
                  <span className="font-mono text-muted-foreground">
                    ({pk.map((idx) => columns[idx]?.name ?? idx).join(", ")})
                  </span>
                </div>
              ))}
              {table.uniqueConstraints.map((uq, i) => (
                <div key={`uq-${i}`} className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-card text-sm">
                  <ShieldCheck className="h-4 w-4 text-blue-500 shrink-0" />
                  <Badge variant="outline" className="text-xs shrink-0">UNIQUE</Badge>
                  <span className="font-mono text-muted-foreground">
                    ({uq.map((idx) => columns[idx]?.name ?? idx).join(", ")})
                  </span>
                </div>
              ))}
              {table.checkConstraints.map((chk, i) => (
                <div key={`chk-${i}`} className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-card text-sm">
                  <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
                  <Badge variant="outline" className="text-xs shrink-0">CHECK</Badge>
                  <code className="text-muted-foreground text-xs">{chk}</code>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Foreign Keys */}
      {foreignKeys.length > 0 && (
        <>
          <Separator className="my-6" />
          <div className="mb-8">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Link2 className="h-3.5 w-3.5" />
              Foreign Keys
            </h2>
            <div className="space-y-2">
              {foreignKeys.map((fk, i) => (
                <div key={i} className="px-4 py-3 rounded-md border border-border bg-card text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-medium">
                      {fk.columns.join(", ")}
                    </span>
                    <span className="text-muted-foreground">references</span>
                    <button
                      className="font-mono text-primary font-medium hover:underline cursor-pointer"
                      onClick={() => onNavigate?.({
                        type: "table",
                        name: fk.referencedTable,
                        schema: fk.referencedSchema,
                      })}
                    >
                      {fk.referencedSchema}.{fk.referencedTable}
                    </button>
                    <span className="font-mono text-muted-foreground">
                      ({fk.referencedColumns.join(", ")})
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Sample SQL */}
      <Separator className="my-6" />
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sample Query
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="h-6 px-2 text-xs"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
        </div>
        <pre className="bg-muted rounded-md px-4 py-3 overflow-x-auto text-sm font-mono">
          {sampleSql}
        </pre>
      </div>
    </div>
  );
}
