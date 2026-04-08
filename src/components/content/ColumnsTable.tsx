import { useState, useMemo, Fragment } from "react";
import { typeColorClass } from "@/lib/tree";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type ExpandedState,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, Key, Link2, ShieldCheck, ChevronRight, Check, Minus } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSettings } from "@/lib/settings";
import type { ColumnInfo, ForeignKeyInfo, ColumnStats } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import type { ProfileData } from "@/lib/column-profiler";
import { ColumnProfile } from "./ColumnProfile";

interface Props {
  columns: ColumnInfo[];
  pkColumns: Set<number>;
  notNullSet: Set<number>;
  fkByColumn: Map<string, ForeignKeyInfo>;
  checkConstraints?: string[];
  columnStats?: Map<string, ColumnStats> | null; // undefined=loading, Map=loaded, null=unavailable
  catalogName?: string;
  schemaName?: string;
  tableName?: string;
  onNavigate?: (selection: Selection) => void;
}

type ColumnRow = ColumnInfo & { idx: number };

export function ColumnsTable({ columns, pkColumns, notNullSet, fkByColumn, checkConstraints, columnStats, catalogName, schemaName, tableName, onNavigate }: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [profileCache, setProfileCache] = useState<Map<string, ProfileData>>(new Map());
  const { settings } = useSettings();

  const hasStats = columnStats instanceof Map;

  // Reset expansion when sorting or filtering changes
  const handleSortingChange = (updater: any) => {
    setSorting(updater);
    setExpanded({});
  };
  const handleFilterChange = (value: string) => {
    setGlobalFilter(value);
    setExpanded({});
  };

  const tableColumns = useMemo<ColumnDef<ColumnRow>[]>(() => [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <button
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => column.toggleSorting()}
        >
          Name
          <SortIcon sorted={column.getIsSorted()} />
        </button>
      ),
      cell: ({ row }) => {
        const col = row.original;
        const fk = fkByColumn.get(col.name);
        const canExpand = hasStats && columnStats.has(col.name);
        return (
          <span className="flex items-center gap-1 font-mono font-medium">
            {hasStats && (
              <button
                className={`shrink-0 transition-transform ${canExpand ? "cursor-pointer hover:text-foreground" : "opacity-0"}`}
                onClick={(e) => {
                  if (canExpand) {
                    e.stopPropagation();
                    row.toggleExpanded();
                  }
                }}
                tabIndex={canExpand ? 0 : -1}
              >
                <ChevronRight className={`h-3 w-3 text-muted-foreground/60 transition-transform ${row.getIsExpanded() ? "rotate-90" : ""}`} />
              </button>
            )}
            {col.name}
            {pkColumns.has(col.idx) && (
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
        );
      },
    },
    {
      id: "type",
      accessorFn: (row) => settings.showDuckDBTypes ? row.duckdbType : row.arrowType,
      header: ({ column }) => (
        <button
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => column.toggleSorting()}
        >
          Type
          <SortIcon sorted={column.getIsSorted()} />
        </button>
      ),
      cell: ({ getValue }) => {
        const type = getValue() as string;
        return (
          <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${typeColorClass(type)}`}>{type}</span>
        );
      },
    },
    {
      id: "nullable",
      accessorFn: (row) => notNullSet.has(row.idx) ? "NOT NULL" : row.nullable ? "yes" : "no",
      header: () => <span className="block text-center">Not Null</span>,
      cell: ({ row }) => {
        const col = row.original;
        const isNotNull = pkColumns.has(col.idx) || notNullSet.has(col.idx) || !col.nullable;
        return isNotNull
          ? <span className="block text-center text-[10px] font-medium text-primary/60">✓</span>
          : null;
      },
      enableSorting: false,
    },
    {
      accessorKey: "comment",
      header: ({ column }) => (
        <button
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => column.toggleSorting()}
        >
          Comment
          <SortIcon sorted={column.getIsSorted()} />
        </button>
      ),
      cell: ({ row }) => {
        const col = row.original;
        const colNamePattern = new RegExp(`\\b${col.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const colChecks = (checkConstraints ?? []).filter(chk =>
          colNamePattern.test(chk)
        );
        const hasConstraintData = col.defaultValue || colChecks.length > 0;
        return (
          <div>
            {col.comment && <div className="text-foreground/70 text-xs">{col.comment}</div>}
            {hasConstraintData && (
              <div className={`flex flex-col gap-0.5 ${col.comment ? "mt-1" : ""}`}>
                {col.defaultValue && (
                  <div className="text-xs text-muted-foreground">
                    default: <code className="bg-muted px-1 rounded">{col.defaultValue}</code>
                  </div>
                )}
                {colChecks.map((chk, i) => (
                  <div key={i} className="inline-flex items-center gap-1 text-xs text-green-700">
                    <ShieldCheck className="h-3 w-3 shrink-0" />
                    <code className="bg-green-50 px-1 rounded">{chk}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      },
      filterFn: (row, _id, filterValue) => {
        const name = row.original.name.toLowerCase();
        const comment = (row.original.comment ?? "").toLowerCase();
        const query = (filterValue as string).toLowerCase();
        return name.includes(query) || comment.includes(query);
      },
    },
  ], [settings.showDuckDBTypes, pkColumns, notNullSet, fkByColumn, onNavigate, checkConstraints, hasStats, columnStats]);

  const data = useMemo(
    () => columns.map((col, idx) => ({ ...col, idx })),
    [columns]
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting, globalFilter, expanded },
    onSortingChange: handleSortingChange,
    onGlobalFilterChange: handleFilterChange,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: (row) => hasStats && columnStats.has(row.original.name),
    globalFilterFn: (row, _id, filterValue) => {
      const query = (filterValue as string).toLowerCase();
      const name = row.original.name.toLowerCase();
      const comment = (row.original.comment ?? "").toLowerCase();
      const type = (settings.showDuckDBTypes ? row.original.duckdbType : row.original.arrowType).toLowerCase();
      return name.includes(query) || comment.includes(query) || type.includes(query);
    },
  });

  const colCount = table.getHeaderGroups()[0]?.headers.length ?? tableColumns.length;

  return (
    <div>
      <div className="border rounded-md bg-card shadow-sm">
        {/* Search — only for tables with many columns */}
        {columns.length > 15 && (
          <div className="relative border-b border-border px-3 py-1.5">
            <Search className="absolute left-5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <Input
              placeholder={`Filter ${columns.length} columns...`}
              value={globalFilter}
              onChange={(e) => handleFilterChange(e.target.value)}
              className="pl-7 pr-7 h-7 text-xs border-0 shadow-none focus-visible:ring-0 bg-transparent"
            />
            {globalFilter && (
              <button
                onClick={() => handleFilterChange("")}
                className="absolute right-5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <Table>
          <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur-sm z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="text-xs">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    className={`even:bg-muted/20 ${row.getCanExpand() ? "cursor-pointer" : ""}`}
                    onClick={() => row.getCanExpand() && row.toggleExpanded()}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="text-sm py-1.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                  {row.getIsExpanded() && hasStats && columnStats.get(row.original.name) && (() => {
                    const stat = columnStats.get(row.original.name)!;
                    const hasProfile = profileCache.has(row.original.name);
                    return (
                      <TableRow className="bg-muted/10 hover:bg-muted/10">
                        <TableCell colSpan={colCount} className="py-2 px-3">
                          <div className="space-y-3 ml-6 border-l-2 border-primary/20 pl-4">
                            {/* Static stats — always visible */}
                            <StatsDetail stat={stat} />
                            {/* Profiling — button or results */}
                            {catalogName && schemaName && tableName && (
                              <ColumnProfile
                                catalogName={catalogName}
                                schemaName={schemaName}
                                tableName={tableName}
                                columnName={row.original.name}
                                columnType={stat.columnType}
                                existingStats={stat}
                                cachedProfile={profileCache.get(row.original.name)}
                                onProfileLoaded={(data) => setProfileCache(prev => new Map(prev).set(row.original.name, data))}
                              />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })()}
                </Fragment>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={colCount} className="h-16 text-center text-muted-foreground">
                  No columns match.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Count — only show when filtered */}
      {globalFilter && (
        <div className="text-xs text-muted-foreground mt-2">
          {table.getFilteredRowModel().rows.length} of {columns.length} columns
        </div>
      )}
    </div>
  );
}

// Types where DuckDB stores exact (non-truncated) min/max values
const EXACT_RANGE_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
  "FLOAT", "DOUBLE", "REAL",
  "DATE", "DATE32", "DATE64",
  "TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_US", "TIMESTAMP_NS",
  "TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ", "DATETIME",
  "GEOMETRY",
]);

/** Expanded detail row showing full stats for a column. */
function StatsDetail({ stat }: { stat: ColumnStats }) {
  const baseType = stat.columnType.split("(")[0].toUpperCase().trim();
  const showRange = (stat.min != null || stat.max != null) &&
    (EXACT_RANGE_TYPES.has(baseType) || baseType.startsWith("DECIMAL"));

  return (
    <div className="flex flex-wrap gap-3">
      {/* Range card */}
      {showRange && (
        <div className="border border-border bg-card rounded-md px-3 py-2 min-w-[140px]">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Range</div>
          <div className="text-sm font-mono text-foreground inline-grid grid-cols-[auto_auto] gap-x-2">
            <span className="text-muted-foreground text-xs text-right">min</span><span className="text-right tabular-nums">{formatDetailValue(stat.min)}</span>
            <span className="text-muted-foreground text-xs text-right">max</span><span className="text-right tabular-nums">{formatDetailValue(stat.max)}</span>
          </div>
        </div>
      )}

      {/* Nullability card */}
      <div className="border border-border bg-card rounded-md px-3 py-2 min-w-[120px]">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Nullability</div>
        <div className="text-xs space-y-0.5">
          <div className="flex items-center gap-1.5">
            {stat.hasNull
              ? <Check className="h-3 w-3 text-amber-500" />
              : <Minus className="h-3 w-3 text-green-500" />}
            <span className="text-foreground/80">Contains NULLs</span>
          </div>
          <div className="flex items-center gap-1.5">
            {stat.hasNotNull
              ? <Check className="h-3 w-3 text-green-500" />
              : <Minus className="h-3 w-3 text-red-400" />}
            <span className="text-foreground/80">Contains values</span>
          </div>
        </div>
      </div>

      {/* Cardinality card */}
      {stat.distinctCount >= 0 && (
        <div className="border border-border bg-card rounded-md px-3 py-2 min-w-[120px]">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Cardinality</div>
          <div className="text-sm font-mono text-foreground">
            ~{stat.distinctCount.toLocaleString()}
          </div>
          <div className="text-[10px] text-muted-foreground">distinct values</div>
        </div>
      )}
    </div>
  );
}

/** Format a stat value for the expanded detail view. */
function formatDetailValue(value: any): string {
  if (value == null) return "—";
  if (typeof value === "bigint") return Number(value).toLocaleString();
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  const s = String(value);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUp className="h-3 w-3" />;
  if (sorted === "desc") return <ArrowDown className="h-3 w-3" />;
  return <ArrowUpDown className="h-3 w-3 opacity-30" />;
}
