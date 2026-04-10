import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, ChevronsLeft, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataGrid } from "./DataGrid";
import type { ColumnInfo } from "@/lib/service";
import { arrowFieldToDuckDB } from "@/lib/arrow-to-duckdb";
import { safeGetArrowValue } from "@/lib/format";
import { bridge } from "@/lib/shell-bridge";

const PAGE_SIZES = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;

interface Props {
  /** Fully qualified table path: catalog.schema.table */
  tablePath: string;
}

async function queryDuckDB(sql: string): Promise<{ table: any; error?: string }> {
  const queryFn = bridge.query;
  if (!queryFn) return { table: null, error: "DuckDB shell not initialized. Open the SQL Shell tab first." };

  const result = await queryFn(sql);
  if (!result.ok) return { table: null, error: result.error || "Query failed" };

  const buf = result.arrowBuffers?.[0];
  if (!buf) return { table: null, error: undefined }; // Empty result

  const { tableFromIPC } = await import("apache-arrow");
  const table = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
  return { table };
}

function arrowTableToRows(table: any): { columns: string[]; columnInfo: ColumnInfo[]; arrowFields: any[]; rows: Record<string, any>[] } {
  const fields = table.schema.fields;
  const columns = fields.map((f: any) => f.name);
  const columnInfo: ColumnInfo[] = fields.map((f: any) => ({
    name: f.name,
    arrowType: f.type?.toString() || "unknown",
    duckdbType: arrowFieldToDuckDB(f),
    nullable: f.nullable,
  }));

  const rows: Record<string, any>[] = [];
  for (let r = 0; r < table.numRows; r++) {
    const row: Record<string, any> = {};
    for (let c = 0; c < fields.length; c++) {
      row[columns[c]] = safeGetArrowValue(table.getChildAt(c), r, fields[c]);
    }
    rows.push(row);
  }

  return { columns, columnInfo, arrowFields: fields, rows };
}

export function DataPreview({ tablePath }: Props) {
  const [columns, setColumns] = useState<string[]>([]);
  const [columnInfo, setColumnInfo] = useState<ColumnInfo[]>([]);
  const [arrowFields, setArrowFields] = useState<any[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(async (pageNum: number, size: number) => {
    const thisRequest = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const offset = pageNum * size;
      const { table, error: queryError } = await queryDuckDB(
        `SELECT * FROM ${tablePath} LIMIT ${size} OFFSET ${offset}`
      );
      if (thisRequest !== requestIdRef.current) return; // stale response
      if (queryError) {
        setError(queryError);
        return;
      }
      if (!table || table.numRows === 0) {
        if (pageNum === 0) {
          setColumns([]);
          setColumnInfo([]);
          setRows([]);
        }
        return;
      }
      const { columns: cols, columnInfo: info, arrowFields: fields, rows: data } = arrowTableToRows(table);
      setColumns(cols);
      setColumnInfo(info);
      setArrowFields(fields);
      setRows(data);
    } catch (err: any) {
      if (thisRequest !== requestIdRef.current) return;
      setError(err.message || "Failed to load data");
    } finally {
      if (thisRequest === requestIdRef.current) setLoading(false);
    }
  }, [tablePath]);

  // Fetch count on first load
  useEffect(() => {
    setPage(0);
    setTotalCount(null);
    setRows([]);
    setColumns([]);

    (async () => {
      try {
        const { table, error: countError } = await queryDuckDB(
          `SELECT COUNT(*) as cnt FROM ${tablePath}`
        );
        if (!countError && table && table.numRows > 0) {
          const cnt = Number(table.getChildAt(0)?.get(0) ?? 0);
          setTotalCount(cnt);
        }
      } catch {}

      await fetchPage(0, pageSize);
    })();
  }, [tablePath, fetchPage, pageSize]);

  // Fetch when page changes (but not on initial load which is handled above)
  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
    fetchPage(newPage, pageSize);
  }, [fetchPage, pageSize]);

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(0);
    fetchPage(0, newSize);
  }, [fetchPage]);

  const totalPages = totalCount != null ? Math.max(1, Math.ceil(totalCount / pageSize)) : null;
  const startRow = page * pageSize;

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <AlertCircle className="h-8 w-8 text-destructive/60 mb-3" />
        <p className="text-sm font-medium text-destructive mb-1">Failed to load data</p>
        <p className="text-xs text-muted-foreground max-w-md">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setError(null); fetchPage(page, pageSize); }}
          className="mt-4 text-xs"
        >
          Retry
        </Button>
      </div>
    );
  }

  // Loading state (initial)
  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading data...</span>
      </div>
    );
  }

  // Empty state
  if (!loading && rows.length === 0 && totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <Database className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No rows in this table</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Data grid — fills available space */}
      <div className="flex-1 min-h-0 overflow-auto">
        <DataGrid
          columnNames={columns}
          columnInfo={columnInfo}
          arrowFields={arrowFields}
          rows={rows}
          startRow={startRow}
          borderless
        />
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-card shrink-0">
        {/* Left: row info */}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin inline mr-1" />
          ) : null}
          Rows {startRow + 1}&ndash;{startRow + rows.length}
          {totalCount != null && ` of ${totalCount.toLocaleString()}`}
        </span>

        {/* Center: page controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(0)}
            disabled={page === 0 || loading}
            className="h-7 w-7 p-0"
            title="First page"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 0 || loading}
            className="h-7 w-7 p-0"
            title="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground px-2 whitespace-nowrap">
            Page {page + 1}{totalPages != null ? ` of ${totalPages}` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(page + 1)}
            disabled={loading || (totalPages != null && page + 1 >= totalPages)}
            className="h-7 w-7 p-0"
            title="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Right: page size selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(val) => handlePageSizeChange(Number(val))}
          >
            <SelectTrigger className="h-7 w-[70px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)} className="text-xs">
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
