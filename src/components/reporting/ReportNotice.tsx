import type { ReactNode } from 'react';
import { CircleAlert, Info, LockKeyhole } from 'lucide-react';

export function ReportNotice({ title, children, kind = 'info', action }: {
  title: string; children?: ReactNode; kind?: 'info' | 'permission' | 'error'; action?: ReactNode;
}) {
  const Icon = kind === 'permission' ? LockKeyhole : kind === 'error' ? CircleAlert : Info;
  return <div role={kind === 'error' ? 'alert' : 'note'} className={`flex items-start gap-3 rounded-md border p-3 text-sm ${kind === 'error' ? 'border-destructive/30 text-destructive' : 'bg-muted/30'}`}>
    <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
    <div className="min-w-0 flex-1"><p className="font-medium">{title}</p>{children && <div className="mt-1 text-muted-foreground">{children}</div>}{action && <div className="mt-2">{action}</div>}</div>
  </div>;
}
