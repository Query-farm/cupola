import { useEffect, useState, useRef, useCallback } from "react";
import { Loader2, AlertCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createTableQuery, getServiceUrl, type ColumnInfo } from "@/lib/service";
import { DataGrid } from "./DataGrid";

interface Props {
  catalogName: string;
  functionName: string;
  columnInfo?: ColumnInfo[];
}

export function DataPreview({ catalogName, functionName, columnInfo }: Props) {
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryRef = useRef<ReturnType<typeof createTableQuery> | null>(null);

  // Load initial page
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows([]);
    setColumns([]);
    setHasMore(false);

    // Clean up previous query session
    queryRef.current?.close();

    const serviceUrl = getServiceUrl();
    const query = createTableQuery(serviceUrl, catalogName, functionName);
    queryRef.current = query;

    query.loadNextPage()
      .then((page) => {
        if (cancelled) return;
        setColumns(page.columns);
        setRows(page.rows);
        setHasMore(page.hasMore);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      query.close();
    };
  }, [catalogName, functionName]);

  // Load more pages
  const loadMore = useCallback(async () => {
    if (!queryRef.current || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await queryRef.current.loadNextPage();
      setRows((prev) => [...prev, ...page.rows]);
      setHasMore(page.hasMore);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more data");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore]);

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

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        No rows returned.
      </div>
    );
  }

  return (
    <div>
      <DataGrid columnNames={columns} columnInfo={columnInfo} rows={rows} />

      {/* Footer: count + load more */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-muted-foreground">
          {rows.length.toLocaleString()} rows loaded
        </span>
        {hasMore && (
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={loadingMore}
            className="h-7 text-xs gap-1.5"
          >
            {loadingMore ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            Load more
          </Button>
        )}
      </div>
    </div>
  );
}
