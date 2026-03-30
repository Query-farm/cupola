import { useMemo } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Props {
  columns: string[];
  rows: Record<string, any>[];
  truncated?: boolean;
}

/** Format a cell value for display. */
function formatValue(value: any): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "[binary]";
  if (typeof value === "object" && value !== null) {
    // Geometry or complex objects
    if (value.type || value.coordinates) return "[geometry]";
    try { return JSON.stringify(value); } catch { return "[object]"; }
  }
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

export function DataGrid({ columns, rows, truncated }: Props) {
  const tableColumns = useMemo<ColumnDef<Record<string, any>>[]>(
    () =>
      columns.map((col) => ({
        accessorKey: col,
        header: col,
        cell: ({ getValue }) => {
          const val = getValue();
          const display = formatValue(val);
          const isNull = val === null || val === undefined;
          return (
            <span className={isNull ? "text-muted-foreground/40 italic" : "font-mono"}>
              {isNull ? "NULL" : display}
            </span>
          );
        },
      })),
    [columns]
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div>
      <div className="border rounded-md overflow-auto max-h-[600px]">
        <Table>
          <TableHeader className="sticky top-0 bg-muted/90 backdrop-blur-sm z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="text-xs font-mono whitespace-nowrap">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className="even:bg-muted/20">
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="text-xs py-1 whitespace-nowrap max-w-[300px] truncate">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="text-xs text-muted-foreground mt-2">
        {rows.length} rows{truncated ? " (preview limited to 100)" : ""}
      </div>
    </div>
  );
}
