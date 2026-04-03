import { useState, useMemo } from "react";
import { typeColorClass } from "@/lib/tree";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, Key, Link2, ShieldCheck, Circle, CircleDot } from "lucide-react";
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
import type { ColumnInfo, ForeignKeyInfo } from "@/lib/service";
import type { Selection } from "@/lib/tree";

interface Props {
  columns: ColumnInfo[];
  pkColumns: Set<number>;
  notNullSet: Set<number>;
  fkByColumn: Map<string, ForeignKeyInfo>;
  checkConstraints?: string[];
  onNavigate?: (selection: Selection) => void;
}

export function ColumnsTable({ columns, pkColumns, notNullSet, fkByColumn, checkConstraints, onNavigate }: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const { settings } = useSettings();

  const tableColumns = useMemo<ColumnDef<ColumnInfo & { idx: number }>[]>(() => [
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
        return (
          <span className="flex items-center gap-1.5 font-mono font-medium">
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
        // Find check constraints that reference this column (word-boundary match)
        const colNamePattern = new RegExp(`\\b${col.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const colChecks = (checkConstraints ?? []).filter(chk =>
          colNamePattern.test(chk)
        );
        const hasConstraints = col.defaultValue || colChecks.length > 0;
        return (
          <div>
            {col.comment && <div className="text-foreground/70 text-xs">{col.comment}</div>}
            {hasConstraints && (
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
        // Custom filter: search name + comment together
        const name = row.original.name.toLowerCase();
        const comment = (row.original.comment ?? "").toLowerCase();
        const query = (filterValue as string).toLowerCase();
        return name.includes(query) || comment.includes(query);
      },
    },
  ], [settings.showDuckDBTypes, pkColumns, notNullSet, fkByColumn, onNavigate]);

  const data = useMemo(
    () => columns.map((col, idx) => ({ ...col, idx })),
    [columns]
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _id, filterValue) => {
      const query = (filterValue as string).toLowerCase();
      const name = row.original.name.toLowerCase();
      const comment = (row.original.comment ?? "").toLowerCase();
      const type = (settings.showDuckDBTypes ? row.original.duckdbType : row.original.arrowType).toLowerCase();
      return name.includes(query) || comment.includes(query) || type.includes(query);
    },
  });

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
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-7 pr-7 h-7 text-xs border-0 shadow-none focus-visible:ring-0 bg-transparent"
            />
            {globalFilter && (
              <button
                onClick={() => setGlobalFilter("")}
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
                <TableRow key={row.id} className="even:bg-muted/20">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="text-sm py-1.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={tableColumns.length} className="h-16 text-center text-muted-foreground">
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

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUp className="h-3 w-3" />;
  if (sorted === "desc") return <ArrowDown className="h-3 w-3" />;
  return <ArrowUpDown className="h-3 w-3 opacity-30" />;
}
