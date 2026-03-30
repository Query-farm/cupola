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
import { formatCellValue, isNullValue } from "@/lib/format";

interface Props {
  columns: string[];
  rows: Record<string, any>[];
}

export function DataGrid({ columns, rows }: Props) {
  const tableColumns = useMemo<ColumnDef<Record<string, any>>[]>(
    () =>
      columns.map((col) => ({
        accessorKey: col,
        header: col,
        cell: ({ getValue, column }) => {
          const val = getValue();
          if (isNullValue(val)) {
            return <span className="text-muted-foreground/30 italic">NULL</span>;
          }
          const display = formatCellValue(val, column.id);
          return <span className="font-mono">{display}</span>;
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
    <div className="border rounded-md overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-muted/90 backdrop-blur-sm z-10">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              <TableHead className="text-xs text-muted-foreground w-10 text-right pr-3 font-mono">#</TableHead>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="text-xs font-mono whitespace-nowrap">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row, idx) => (
            <TableRow key={row.id} className="even:bg-muted/15 hover:bg-accent/5">
              <TableCell className="text-xs text-muted-foreground/40 text-right pr-3 font-mono py-1 w-10">
                {idx + 1}
              </TableCell>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className="text-xs py-1 whitespace-nowrap max-w-[400px] truncate">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
