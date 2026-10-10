import { useEffect, useRef } from 'react';
import { listEvidenceReports } from '../evidence/reports';
import type { TransferSource } from './transfers';

const EVENT = 'cupola:prepare-report-transfer';
interface Request { scope: string; location: string; id: string; result?: Promise<TransferSource> }

/** The open editor owns its draft. Ask it before using a sidebar snapshot. */
export function requestTransferSource(scope: string, source: TransferSource): Promise<TransferSource> {
  const detail: Request = { scope, location: source.kind === 'local' ? 'local' : source.url, id: source.kind === 'local' ? source.report.id : source.record.report_id };
  window.dispatchEvent(new CustomEvent<Request>(EVENT, { detail }));
  return detail.result ?? Promise.resolve().then(() => {
    if (source.kind === 'worker') return source;
    const report = listEvidenceReports(scope).find(r => r.id === source.report.id);
    if (!report) throw new Error('This report no longer exists on this device.');
    return { kind: 'local' as const, report };
  });
}

export function useTransferSource(scope: string, location: string | null, id: string, prepare: () => TransferSource) {
  const current = useRef(prepare); current.current = prepare;
  useEffect(() => {
    if (!location) return;
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<Request>).detail;
      if (detail.scope === scope && detail.location === location && detail.id === id && !detail.result) detail.result = Promise.resolve().then(() => current.current());
    };
    window.addEventListener(EVENT, handle);
    return () => window.removeEventListener(EVENT, handle);
  }, [scope, location, id]);
}
