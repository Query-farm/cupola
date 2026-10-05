/**
 * Contents of the sidebar's hover/focus preview. Kept small: the signature,
 * one paragraph of description and the first few columns, with the full
 * detail one click away in the Inspector or the catalog page.
 */
import type { Callable } from "@/lib/callable";
import type { Relation } from "@/lib/relation";
import { SignatureView, callableKindLabel } from "./SignatureView";

const MAX_COLUMNS = 8;
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

function Hint({ editor }: { editor: boolean }) {
  return (
    <div className="mt-2 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
      {editor ? `Click for details · ${MOD}-click to insert` : "Click for details"}
    </div>
  );
}

function ColumnPeek({ columns }: { columns: { name: string; duckdbType: string }[] }) {
  if (!columns.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
      {columns.slice(0, MAX_COLUMNS).map((c) => (
        <li key={c.name} className="flex gap-2 min-w-0">
          <span className="truncate text-foreground/90">{c.name}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{c.duckdbType}</span>
        </li>
      ))}
      {columns.length > MAX_COLUMNS && <li className="text-muted-foreground">+{columns.length - MAX_COLUMNS} more</li>}
    </ul>
  );
}

export function CallableHoverCard({ callables, editor }: { callables: Callable[]; editor: boolean }) {
  const c = callables[0];
  return (
    <div data-testid="hover-card-callable">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {callableKindLabel(c)} · {c.schema}
        {callables.length > 1 && ` · ${callables.length} overloads`}
      </div>
      <SignatureView callable={c} />
      {c.description && <p className="mt-1.5 line-clamp-3 text-muted-foreground">{c.description}</p>}
      {c.isTable && c.ret.columns.length > 0 && (
        <>
          <div className="mt-2 text-[11px] font-medium text-muted-foreground">Returns</div>
          <ColumnPeek columns={c.ret.columns} />
        </>
      )}
      <Hint editor={editor} />
    </div>
  );
}

export function RelationHoverCard({ relation, editor }: { relation: Relation; editor: boolean }) {
  return (
    <div data-testid="hover-card-relation">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {relation.kind} · {relation.schema}
        {relation.columns.length > 0 && ` · ${relation.columns.length} column${relation.columns.length === 1 ? "" : "s"}`}
      </div>
      <div className="font-mono text-xs font-semibold">{relation.name}</div>
      {relation.description && <p className="mt-1.5 line-clamp-3 text-muted-foreground">{relation.description}</p>}
      <ColumnPeek columns={relation.columns} />
      <Hint editor={editor} />
    </div>
  );
}
