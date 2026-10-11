import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import type { Mail } from 'lucide-react';

export const scheduleInput = 'w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export function ScheduleField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  return <div className="space-y-1.5 text-sm"><label htmlFor={id} className="block font-medium">{label}</label>{Children.map(children, child => isValidElement(child) && ['input', 'select', 'textarea'].includes(String(child.type)) ? cloneElement(child as ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id, 'aria-describedby': hint ? `${id}-hint` : undefined }) : child)}{hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}</div>;
}
export function ScheduleSection({ title, icon: Icon, children }: { title: string; icon?: typeof Mail; children: ReactNode }) {
  return <section className="rounded-lg border bg-card"><h2 className="flex items-center gap-2 border-b bg-muted/30 px-5 py-3 text-sm font-semibold">{Icon && <Icon className="size-4" />}{title}</h2><div className="space-y-4 p-5">{children}</div></section>;
}

