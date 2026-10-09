import { useEffect, useState } from 'react';
import type { CatalogData } from '../../lib/service';
import { ReportingWorkspace } from '../reporting/ReportingWorkspace';

/** Cupola chrome uses the app design system; only the third-party renderer is isolated. */
export function EvidencePanel(props: { catalogName: string; serviceUrl: string; workspaceId?: string; catalogs: readonly CatalogData[]; defaultToLibrary?: boolean }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <div data-testid="evidence-panel" className="h-full">{mounted ? <ReportingWorkspace key={props.workspaceId ?? props.serviceUrl} {...props} /> : <p className="p-4 text-sm text-muted-foreground">Loading reports…</p>}</div>;
}
