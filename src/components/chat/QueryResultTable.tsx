import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

interface Props {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  showing: number;
}

export function QueryResultTable({ columns, rows, rowCount, showing }: Props) {
  if (rows.length === 0) return null;

  return (
    <div>
      <div className="border rounded-md overflow-auto max-h-[300px]">
        <Table>
          <TableHeader className="sticky top-0 bg-muted/90 backdrop-blur-sm z-10">
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col} className="text-xs font-mono whitespace-nowrap">{col}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i} className="even:bg-muted/15">
                {columns.map((col) => {
                  const val = row[col];
                  const isNull = val === null || val === undefined || val === "NULL";
                  return (
                    <TableCell key={col} className="text-xs font-mono py-1 whitespace-nowrap max-w-[200px] truncate">
                      {isNull ? <span className="text-muted-foreground/30 italic">NULL</span> : String(val)}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rowCount > showing && (
        <div className="text-[10px] text-muted-foreground mt-1">
          Showing {showing} of {rowCount.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
