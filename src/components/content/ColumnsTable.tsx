import { useState, useMemo } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown, Search, Key, Link2, ShieldCheck, Circle, CircleDot } from "lucide-react";
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
  onNavigate?: (selection: Selection) => void;
}

export function ColumnsTable({ columns, pkColumns, notNullSet, fkByColumn, onNavigate }: Props) {
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
      cell: ({ getValue }) => (
        <span className="font-mono text-muted-foreground">{getValue() as string}</span>
      ),
    },
    {
      id: "nullable",
      accessorFn: (row) => notNullSet.has(row.idx) ? "NOT NULL" : row.nullable ? "yes" : "no",
      header: "Null",
      cell: ({ row }) => {
        const col = row.original;
        if (notNullSet.has(col.idx)) {
          return (
            <span className="flex items-center gap-1" title="NOT NULL constraint">
              <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
            </span>
          );
        }
        return col.nullable
          ? <Circle className="h-3.5 w-3.5 text-muted-foreground/30" title="Nullable" />
          : <CircleDot className="h-3.5 w-3.5 text-foreground/70" title="Not nullable" />;
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
        return (
          <span>
            {col.comment && <span className="text-foreground/70 text-xs">{col.comment}</span>}
            {col.defaultValue && (
              <span className="ml-2 text-xs text-muted-foreground">
                default: <code className="bg-muted px-1 rounded">{col.defaultValue}</code>
              </span>
            )}
          </span>
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
      {/* Search */}
      <div className="relative mb-3 max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search columns..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="pl-8 h-9 text-sm"
        />
      </div>

      {/* Table */}
      <div className="border rounded-md">
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

      {/* Count */}
      <div className="text-xs text-muted-foreground mt-2">
        {table.getFilteredRowModel().rows.length} of {columns.length} columns
      </div>
    </div>
  );
}

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUp className="h-3 w-3" />;
  if (sorted === "desc") return <ArrowDown className="h-3 w-3" />;
  return <ArrowUpDown className="h-3 w-3 opacity-30" />;
}
