import { useMemo, useState } from "react";
import { Table2, Copy, Check, Key, Link2, ShieldCheck, Circle, CircleDot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { getColumns, getForeignKeys, type ForeignKeyInfo } from "@/lib/service";
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

  const constraintCount =
    foreignKeys.length +
    table.primaryKeyConstraints.length +
    table.uniqueConstraints.length +
    table.checkConstraints.length;

  function handleCopy() {
    navigator.clipboard.writeText(sampleSql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <Table2 className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold font-mono text-primary">{table.name}</h1>
        <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700">table</Badge>
      </div>
      {table.comment && (
        <p className="text-muted-foreground mb-4">{table.comment}</p>
      )}

      {/* Tabs */}
      <Tabs defaultValue="columns" className="flex-1">
        <TabsList>
          <TabsTrigger value="columns">
            Columns
            <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">{columns.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="constraints">
            Constraints
            {constraintCount > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">{constraintCount}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="sql">SQL</TabsTrigger>
        </TabsList>

        {/* Columns Tab */}
        <TabsContent value="columns" className="mt-4">
          {columns.length > 0 && (
            <div className="border rounded-md">
              <Table>
                <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur-sm z-10">
                  <TableRow>
                    <TableHead className="text-xs w-[30%]">Name</TableHead>
                    <TableHead className="text-xs w-[20%]">Type</TableHead>
                    <TableHead className="text-xs w-[8%]">Null</TableHead>
                    <TableHead className="text-xs">Comment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {columns.map((col, idx) => {
                    const fk = fkByColumn.get(col.name);
                    return (
                      <TableRow key={col.name} className="even:bg-muted/20">
                        <TableCell className="font-mono text-sm font-medium py-1.5">
                          <span className="flex items-center gap-1.5">
                            {col.name}
                            {pkColumns.has(idx) && (
                              <Key className="h-3 w-3 text-amber-500 shrink-0" title="Primary key" />
                            )}
                            {fk && (
                              <button
                                className="shrink-0 hover:text-primary transition-colors"
                                title={`References ${fk.referencedSchema}.${fk.referencedTable}(${fk.referencedColumns.join(", ")})`}
                                onClick={() => onNavigate?.({
                                  type: "table",
                                  name: fk.referencedTable,
                                  schema: fk.referencedSchema,
                                })}
                              >
                                <Link2 className="h-3 w-3 text-primary/60" />
                              </button>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground py-1.5">
                          {settings.showDuckDBTypes ? col.duckdbType : col.arrowType}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground py-1.5">
                          {notNullSet.has(idx) ? (
                            <span className="flex items-center gap-1" title="NOT NULL constraint">
                              <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
                            </span>
                          ) : col.nullable ? (
                            <Circle className="h-3.5 w-3.5 text-muted-foreground/30" title="Nullable" />
                          ) : (
                            <CircleDot className="h-3.5 w-3.5 text-foreground/70" title="Not nullable" />
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground py-1.5">
                          {col.comment && (
                            <span className="text-foreground/70 text-xs">{col.comment}</span>
                          )}
                          {col.defaultValue && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              default: <code className="bg-muted px-1 rounded">{col.defaultValue}</code>
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Constraints Tab */}
        <TabsContent value="constraints" className="mt-4 space-y-6">
          {/* Foreign Keys */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Link2 className="h-3.5 w-3.5" />
              Foreign Keys
            </h3>
            {foreignKeys.length > 0 ? (
              <div className="space-y-1.5">
                {foreignKeys.map((fk, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm flex-wrap">
                    <span className="font-mono font-medium">{fk.columns.join(", ")}</span>
                    <span className="text-muted-foreground">&rarr;</span>
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
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground/60 italic">None</p>
            )}
          </div>

          {/* Primary Keys */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Key className="h-3.5 w-3.5" />
              Primary Keys
            </h3>
            {table.primaryKeyConstraints.length > 0 ? (
              <div className="space-y-1.5">
                {table.primaryKeyConstraints.map((pk, i) => (
                  <div key={i} className="text-sm font-mono">
                    ({pk.map((idx) => columns[idx]?.name ?? idx).join(", ")})
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground/60 italic">None</p>
            )}
          </div>

          {/* Unique Constraints */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              Unique Constraints
            </h3>
            {table.uniqueConstraints.length > 0 ? (
              <div className="space-y-1.5">
                {table.uniqueConstraints.map((uq, i) => (
                  <div key={i} className="text-sm font-mono">
                    ({uq.map((idx) => columns[idx]?.name ?? idx).join(", ")})
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground/60 italic">None</p>
            )}
          </div>

          {/* Check Constraints */}
          {table.checkConstraints.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                Check Constraints
              </h3>
              <div className="space-y-1.5">
                {table.checkConstraints.map((chk, i) => (
                  <code key={i} className="block text-sm text-muted-foreground bg-muted px-3 py-1.5 rounded">
                    {chk}
                  </code>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        {/* SQL Tab */}
        <TabsContent value="sql" className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sample Query
            </h3>
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
