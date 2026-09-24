import { useEffect, useRef, useState } from 'react';
import { decodeArrowBuffer } from '../../lib/duckdb-query';
import { resolveBrowserDataset, type EvidenceDataContext } from '../../lib/evidence/data-browser';

/** Uses Cupola's existing Perspective loader and the active Haybarn adapter. */
export function EvidencePivot({ context, datasetId, config, onConfig, mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light' }: {
  mode?: 'light' | 'dark'; context: EvidenceDataContext; datasetId: string; config?: Record<string, any>;
  onConfig: (config: Record<string, any>) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ config, onConfig, mode }); latest.current = { config, onConfig, mode };
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const container = host.current!;
    let disposed = false;
    let viewer: any;
    let listener: (() => void) | undefined;
    setLoading(true); setError('');
    void (async () => {
      try {
        const sql = resolveBrowserDataset(context, datasetId);
        const buffer = await context.service.queryArrow(`SELECT * FROM (${sql.replace(/;+\s*$/, '')}\n) AS cupola_pivot_data LIMIT 10001`);
        if (disposed) return;
        if (decodeArrowBuffer(buffer).numRows > 10000) throw new Error('This dataset has more than 10,000 rows. Filter or aggregate the source query before pivoting so totals cover the complete dataset.');
        const { loadPerspective } = await import('../DuckDBShell');
        if (disposed) return;
        if (!await loadPerspective(container, buffer, { path: 'report', sql })) return;
        if (disposed) return;
        viewer = container.querySelector('perspective-viewer') as any;
        await viewer.restore({ ...latest.current.config, theme: latest.current.mode === 'dark' ? 'Pro Dark' : 'Pro Light', settings: true });
        if (disposed) return;
        listener = async () => {
          try { const next = await viewer.save(); if (!disposed) latest.current.onConfig(next); } catch { /* Viewer may be closing. */ }
        };
        viewer.addEventListener('perspective-config-update', listener);
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (!disposed) setLoading(false); }
    })();
    return () => {
      disposed = true;
      if (viewer && listener) viewer.removeEventListener('perspective-config-update', listener);
      void import('../DuckDBShell').then(({ releasePerspective }) => releasePerspective(container));
    };
  }, [context, datasetId]);
  useEffect(() => {
    const viewer = host.current?.querySelector('perspective-viewer') as any;
    if (viewer?.restore) void viewer.restore({ theme: mode === 'dark' ? 'Pro Dark' : 'Pro Light' }).catch(() => {});
  }, [mode]);
  return <div className="space-y-2">
    {loading && <p role="status" className="text-xs text-muted-foreground">Loading pivot…</p>}
    {error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
    <div ref={host} data-testid="evidence-pivot" className={error ? 'hidden' : 'h-[520px] min-w-0 overflow-hidden rounded border bg-white'} />
  </div>;
}
