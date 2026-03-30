import { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { queryTable, getServiceUrl, type QueryResult } from "@/lib/service";
import { DataGrid } from "./DataGrid";

interface Props {
  catalogName: string;
  functionName: string;
}

export function DataPreview({ catalogName, functionName }: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);

    const serviceUrl = getServiceUrl();
    queryTable(serviceUrl, catalogName, functionName)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [catalogName, functionName]);

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

  if (!result || result.rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        No rows returned.
      </div>
    );
  }

  return <DataGrid columns={result.columns} rows={result.rows} truncated={result.truncated} />;
}
