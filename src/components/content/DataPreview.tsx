import { useEffect, useState, useRef, useCallback } from "react";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, ChevronsLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createTableQuery, getServiceUrl, type ColumnInfo } from "@/lib/service";
import { DataGrid } from "./DataGrid";

const PAGE_SIZES = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;

interface Props {
  catalogName: string;
  functionName: string;
  columnInfo?: ColumnInfo[];
}

export function DataPreview({ catalogName, functionName, columnInfo }: Props) {
  const [allRows, setAllRows] = useState<Record<string, any>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [serverHasMore, setServerHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const queryRef = useRef<ReturnType<typeof createTableQuery> | null>(null);
  const closedRef = useRef(false);

  // Fetch initial data
  useEffect(() => {
    closedRef.current = false;
    setLoading(true);
    setError(null);
    setAllRows([]);
    setColumns([]);
    setServerHasMore(false);
    setPage(0);

    queryRef.current?.close();

    const serviceUrl = getServiceUrl();
    const query = createTableQuery(serviceUrl, catalogName, functionName);
    queryRef.current = query;

    query.loadNextPage()
      .then((result) => {
        if (closedRef.current) return;
        setColumns(result.columns);
        setAllRows(result.rows);
        setServerHasMore(result.hasMore);
      })
      .catch((err: unknown) => {
        if (closedRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load data");
      })
      .finally(() => {
        if (!closedRef.current) setLoading(false);
      });

    return () => {
      closedRef.current = true;
      // Don't close the query here — we need it for "load more"
    };
  }, [catalogName, functionName]);

  // Fetch more rows from server
  const fetchMore = useCallback(async () => {
    if (!queryRef.current || fetchingMore || !serverHasMore) return;
    setFetchingMore(true);
    try {
      const result = await queryRef.current.loadNextPage();
      setAllRows((prev) => [...prev, ...result.rows]);
      setServerHasMore(result.hasMore);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more data");
    } finally {
      setFetchingMore(false);
    }
  }, [fetchingMore, serverHasMore]);

  // Current page window
  const totalLoaded = allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalLoaded / pageSize));
  const startIdx = page * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalLoaded);
  const pageRows = allRows.slice(startIdx, endIdx);
  const isLastPage = endIdx >= totalLoaded;
  const canLoadMore = isLastPage && serverHasMore;

  // Auto-advance: when user is on last page and clicks next, fetch more
  const handleNext = useCallback(async () => {
    if (page + 1 < totalPages) {
      setPage(page + 1);
    } else if (serverHasMore) {
      await fetchMore();
      setPage(page + 1);
    }
  }, [page, totalPages, serverHasMore, fetchMore]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16 text-destructive gap-2">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        No rows returned.
      </div>
    );
  }

  return (
    <div>
      <DataGrid columnNames={columns} columnInfo={columnInfo} rows={pageRows} startRow={startIdx} />

      {/* Pagination footer */}
      <div className="flex items-center justify-between mt-3 gap-4">
        {/* Left: row info */}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          Rows {startIdx + 1}&ndash;{endIdx} of {totalLoaded.toLocaleString()}{serverHasMore ? "+" : ""} loaded
        </span>

        {/* Center: page controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(0)}
            disabled={page === 0}
            className="h-7 w-7 p-0"
            title="First page"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(page - 1)}
            disabled={page === 0}
            className="h-7 w-7 p-0"
            title="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground px-2 whitespace-nowrap">
            Page {page + 1}{!serverHasMore ? ` of ${totalPages}` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNext}
            disabled={isLastPage && !serverHasMore}
            className="h-7 w-7 p-0"
            title={canLoadMore ? "Load next page" : "Next page"}
          >
            {fetchingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {/* Right: page size selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(val) => {
              const newSize = Number(val);
              setPageSize(newSize);
              setPage(0);
            }}
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
