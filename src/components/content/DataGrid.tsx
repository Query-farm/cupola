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
import type { ColumnInfo } from "@/lib/service";
import { GeometryViewer } from "./GeometryViewer";

interface Props {
  columnNames: string[];
  columnInfo?: ColumnInfo[];
  rows: Record<string, any>[];
  startRow?: number;
  /** Remove outer border and rounding for embedding in full-bleed containers. */
  borderless?: boolean;
}

/** DuckDB types that should be right-aligned. */
const NUMERIC_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
  "FLOAT", "DOUBLE", "DECIMAL",
  "HUGEINT", "UHUGEINT",
]);

function isNumericType(duckdbType: string): boolean {
  // Handle parameterized types like DECIMAL(18,2)
  const base = duckdbType.split("(")[0].toUpperCase();
  return NUMERIC_TYPES.has(base);
}

export function DataGrid({ columnNames, columnInfo, rows, startRow = 0, borderless }: Props) {
  // Build a map of column name → ColumnInfo for type lookups
  const infoByName = useMemo(() => {
    const map = new Map<string, ColumnInfo>();
    if (columnInfo) {
      for (const col of columnInfo) map.set(col.name, col);
    }
    return map;
  }, [columnInfo]);

  const tableColumns = useMemo<ColumnDef<Record<string, any>>[]>(
    () =>
      columnNames.map((col) => {
        const info = infoByName.get(col);
        const numeric = info ? isNumericType(info.duckdbType) : false;
        const isGeometry = info?.duckdbType === "GEOMETRY";
        return {
          accessorKey: col,
          header: () => (
            <span className={numeric ? "text-right block" : ""}>{col}</span>
          ),
          cell: ({ getValue, column, row }) => {
            const val = getValue();
            if (isNullValue(val)) {
              return <span className={`text-muted-foreground/30 italic ${numeric ? "text-right block" : ""}`}>NULL</span>;
            }
            // Geometry: render clickable map viewer
            if (isGeometry && val instanceof Uint8Array) {
              const rowIdx = startRow + row.index + 1;
              return <GeometryViewer wkb={val} label={`Row ${rowIdx}`} />;
            }
            const display = formatCellValue(val, column.id);
            return <span className={`font-mono ${numeric ? "text-right block tabular-nums" : ""}`}>{display}</span>;
          },
        };
      }),
    [columnNames, infoByName]
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className={borderless ? "overflow-auto" : "border rounded-md overflow-auto"}>
      <Table>
        <TableHeader className={`sticky top-0 z-10 ${borderless ? "bg-primary/10 border-b border-primary/20" : "bg-muted/90 backdrop-blur-sm"}`}>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className={borderless ? "border-none" : ""}>
              <TableHead className={`text-xs w-10 text-right pr-3 font-mono ${borderless ? "text-primary/60" : "text-muted-foreground"}`}>#</TableHead>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className={`text-xs font-mono whitespace-nowrap ${borderless ? "text-primary/80 font-semibold" : ""}`}>
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
                {startRow + idx + 1}
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
