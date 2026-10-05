/**
 * The editor's Inspector: details of the function, macro, table or view last
 * clicked in the sidebar, laid out for a narrow side panel. Every name in it
 * can be written into the query, which is the point of having it beside the
 * editor rather than on the catalog page.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Key, Pin, PinOff, Search, SquareFunction, Table2, Eye, Braces, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCatalogInventory } from "@/lib/use-catalog-inventory";
import { callablesForSelection, type Callable } from "@/lib/callable";
import { findRelation, type Relation } from "@/lib/relation";
import type { Selection } from "@/lib/tree";
import type { ColumnInfo } from "@/lib/service";
import { readRows, quoteLiteral } from "@/lib/duckdb-query";
import { engine } from "@/lib/shell-bridge";
import { parseExecutableExamples, TAG_EXAMPLE_QUERIES } from "@/lib/tags";
import type { FunctionInfo } from "@/lib/vgi-catalog-types";
import type { ProfileData } from "@/lib/column-profiler";
import { sqlIdentifier } from "@/lib/editor/call-snippet";
import { ColumnTypeBadge } from "@/components/content/ColumnTypeBadge";
import { DescriptionSection } from "@/components/content/DescriptionSection";
import { ExampleQueries } from "@/components/content/ExampleQueries";
import { ColumnProfile } from "@/components/content/ColumnProfile";
import { SignatureView, callableKindLabel } from "./SignatureView";

export interface InspectorProps {
  /** What to show: a function, macro, table or view selection. */
  target: Selection | null;
  pinned: boolean;
  onTogglePin: () => void;
  onOpenFullPage: (selection: Selection) => void;
  /** Write text into the editor at the cursor. */
  onInsertText: (text: string) => void;
  /** Write a call (as a snippet) into the editor. */
  onInsertCallable: (callable: Callable) => void;
  /** Write a table/view reference (a SELECT in an empty editor). */
  onInsertRelation: (dotted: string) => void;
}

const ICONS = { function: SquareFunction, macro: Braces, table: Table2, view: Eye } as const;

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-4 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

export function Inspector({ target, pinned, onTogglePin, onOpenFullPage, onInsertText, onInsertCallable, onInsertRelation }: InspectorProps) {
  const { catalogs } = useCatalogInventory();
  const callables = useMemo(() => callablesForSelection(catalogs, target), [catalogs, target]);
  const relation = useMemo(() => findRelation(catalogs, target), [catalogs, target]);
  const found = callables.length > 0 || relation;
  const Icon = target && target.type in ICONS ? ICONS[target.type as keyof typeof ICONS] : null;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="editor-inspector">
      {target && found && (
        <div className="flex items-start gap-2 border-b border-border px-3 py-2">
          {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm font-semibold" data-testid="inspector-title">{target.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">{target.catalog}.{target.schema}</div>
          </div>
          <button
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            onClick={onTogglePin}
            aria-pressed={pinned}
            title={pinned ? "Unpin: follow the sidebar again" : "Pin: keep showing this while browsing the sidebar"}
            aria-label={pinned ? "Unpin inspector" : "Pin inspector"}
            data-testid="inspector-pin"
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
          <button
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            onClick={() => onOpenFullPage(target)}
            title="Open the full catalog page"
            aria-label="Open full page"
            data-testid="inspector-open-full"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {!target || !found ? (
          <p className="pt-3 text-xs text-muted-foreground" data-testid="inspector-empty">
            Click a function, macro, table or view in the sidebar to see its details here.
          </p>
        ) : callables.length > 0 ? (
          <CallableSection key={`${target.catalog}.${target.schema}.${target.name}`} callables={callables} onInsertText={onInsertText} onInsertCallable={onInsertCallable} />
        ) : relation ? (
          <RelationSection key={`${relation.catalog}.${relation.schema}.${relation.name}`} relation={relation} onInsertText={onInsertText} onInsertRelation={onInsertRelation} />
        ) : null}
      </div>
    </div>
  );
}

function CallableSection({ callables, onInsertText, onInsertCallable }: {
  callables: Callable[];
  onInsertText: (text: string) => void;
  onInsertCallable: (c: Callable) => void;
}) {
  const [overload, setOverload] = useState(0);
  const c = callables[Math.min(overload, callables.length - 1)];
  const examples = useMemo(() => {
    const func = c.source as Partial<FunctionInfo>;
    return [
      ...(func.examples ?? []).map((e) => ({ description: e.description || null, sql: e.sql })),
      ...parseExecutableExamples(c.source.tags ?? {}),
    ];
  }, [c]);

  return (
    <div data-testid="inspector-callable">
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{callableKindLabel(c)}</span>
        {callables.length > 1 && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
            {callables.map((_, i) => (
              <button
                key={i}
                onClick={() => setOverload(i)}
                aria-pressed={i === overload}
                className={`rounded px-1.5 ${i === overload ? "bg-muted text-foreground" : "hover:text-foreground"}`}
              >
                {i + 1}
              </button>
            ))}
            <span>of {callables.length}</span>
          </span>
        )}
      </div>
      <div className="mt-1.5 rounded-md bg-muted/60 px-2.5 py-2">
        <SignatureView callable={c} />
      </div>
      <Button size="sm" className="mt-2 h-7 gap-1.5 text-xs" onClick={() => onInsertCallable(c)} data-testid="inspector-insert-call">
        <TerminalSquare className="h-3.5 w-3.5" /> Insert call
      </Button>
      {c.description && <p className="mt-3 text-sm text-foreground/90 whitespace-pre-wrap">{c.description}</p>}
      {c.docMd && <div className="mt-2 text-sm"><DescriptionSection markdown={c.docMd} defaultOpen={!c.description} /></div>}

      {c.args.length > 0 && (
        <>
          <SectionTitle>Arguments</SectionTitle>
          <ul className="space-y-2" data-testid="inspector-args">
            {c.args.map((a) => (
              <li key={a.name} className="rounded-md border border-border px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  {a.named ? (
                    <button
                      className="font-mono font-medium text-accent hover:underline"
                      title={`Insert ${a.name} := `}
                      onClick={() => onInsertText(`${sqlIdentifier(a.name)} := `)}
                    >
                      {a.name} :=
                    </button>
                  ) : (
                    <span className="font-mono font-medium">{a.name}</span>
                  )}
                  <ColumnTypeBadge type={a.isAnyType ? "ANY" : a.isTableInput ? "TABLE" : a.duckdbType} />
                  {a.named && <span className="text-[10px] text-muted-foreground">named</span>}
                  {a.isVarargs && <span className="text-[10px] text-muted-foreground">variadic</span>}
                  {a.isConst && <span className="text-[10px] text-muted-foreground">constant</span>}
                  {a.defaultValue !== undefined && <span className="text-[10px] text-muted-foreground">default <code>{a.defaultValue}</code></span>}
                </div>
                {a.description && <p className="mt-1 text-muted-foreground whitespace-pre-wrap break-words">{a.description}</p>}
                {(a.choices || a.range || a.pattern) && (
                  <p className="mt-1 text-[11px] text-muted-foreground break-words">
                    {a.choices && <>One of {a.choices.map((v) => <code key={v} className="mx-0.5 rounded bg-muted px-1">{v}</code>)}</>}
                    {a.range && <> Range <code>{a.range}</code></>}
                    {a.pattern && <> Pattern <code>{a.pattern}</code></>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {c.ret.columns.length > 0 && (c.isTable ? (
        <>
          <SectionTitle>Returns</SectionTitle>
          <ColumnList columns={c.ret.columns} onInsertText={onInsertText} />
        </>
      ) : (
        <>
          <SectionTitle>Returns</SectionTitle>
          <ColumnTypeBadge type={c.ret.columns[0].duckdbType} />
        </>
      ))}

      {c.kind === "macro" && "definition" in c.source && c.source.definition && (
        <>
          <SectionTitle>Definition</SectionTitle>
          <pre className="overflow-x-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap break-words">{c.source.definition}</pre>
        </>
      )}

      <ExampleQueries exampleQueriesJson={c.source.tags?.[TAG_EXAMPLE_QUERIES]} queries={examples} onOpenShell={() => {}} />
    </div>
  );
}

function ColumnList({ columns, primaryKey, onInsertText, profile }: {
  columns: ColumnInfo[];
  primaryKey?: Set<string>;
  onInsertText: (text: string) => void;
  /** Present for tables: expanding a column offers a distribution profile. */
  profile?: { catalog: string; schema: string; table: string };
}) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [profiles, setProfiles] = useState<Record<string, ProfileData>>({});
  const shown = filter ? columns.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase())) : columns;
  return (
    <div data-testid="inspector-columns">
      {columns.length > 12 && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter columns…" aria-label="Filter columns" className="h-7 pl-7 text-xs" />
        </div>
      )}
      <ul className="divide-y divide-border rounded-md border border-border text-xs">
        {shown.map((col) => {
          const isOpen = open.has(col.name);
          const toggle = () => setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(col.name)) next.delete(col.name); else next.add(col.name);
            return next;
          });
          return (
            <li key={col.name} className="px-2 py-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                {profile ? (
                  <button onClick={toggle} aria-expanded={isOpen} aria-label={`Details for ${col.name}`} className="text-muted-foreground hover:text-foreground">
                    <ChevronRight className={`h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  </button>
                ) : null}
                {primaryKey?.has(col.name) && <Key className="h-3 w-3 shrink-0 text-sun-600" aria-label="Primary key" />}
                <button
                  className="truncate font-mono font-medium hover:text-primary hover:underline"
                  title={`Insert ${col.name}`}
                  onClick={() => onInsertText(sqlIdentifier(col.name))}
                  data-testid="inspector-column"
                >
                  {col.name}
                </button>
                <span className="ml-auto shrink-0"><ColumnTypeBadge type={col.duckdbType} /></span>
              </div>
              {col.comment && <p className="mt-0.5 pl-5 text-muted-foreground line-clamp-2">{col.comment}</p>}
              {isOpen && profile && (
                <div className="mt-1.5 pl-5">
                  <ColumnProfile
                    catalogName={profile.catalog}
                    schemaName={profile.schema}
                    tableName={profile.table}
                    columnName={col.name}
                    columnType={col.duckdbType}
                    cachedProfile={profiles[col.name]}
                    onProfileLoaded={(data) => setProfiles((p) => ({ ...p, [col.name]: data }))}
                  />
                </div>
              )}
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">No matching columns.</li>}
      </ul>
    </div>
  );
}

function RelationSection({ relation, onInsertText, onInsertRelation }: {
  relation: Relation;
  onInsertText: (text: string) => void;
  onInsertRelation: (dotted: string) => void;
}) {
  // A VGI view's columns are only known to the engine.
  const [viewColumns, setViewColumns] = useState<ColumnInfo[] | null>(null);
  useEffect(() => {
    if (relation.kind !== "view" || relation.columns.length > 0 || !engine.query) return;
    let cancelled = false;
    readRows(
      `SELECT column_name, data_type FROM duckdb_columns() WHERE database_name = ${quoteLiteral(relation.catalog)}` +
        ` AND schema_name = ${quoteLiteral(relation.schema)} AND table_name = ${quoteLiteral(relation.name)} ORDER BY column_index`,
    ).then((rows) => {
      if (cancelled || !rows) return;
      setViewColumns(rows.map((r) => ({ name: String(r.column_name), arrowType: String(r.data_type), duckdbType: String(r.data_type), nullable: true })));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [relation]);
  const columns = relation.columns.length > 0 ? relation.columns : viewColumns ?? [];
  const dotted = [relation.catalog, relation.schema, relation.name].map(sqlIdentifier).join(".");

  return (
    <div data-testid="inspector-relation">
      <div className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {relation.kind}{columns.length > 0 && ` · ${columns.length} column${columns.length === 1 ? "" : "s"}`}
      </div>
      <Button size="sm" className="mt-2 h-7 gap-1.5 text-xs" onClick={() => onInsertRelation(dotted)} data-testid="inspector-insert-relation">
        <TerminalSquare className="h-3.5 w-3.5" /> Insert {relation.kind}
      </Button>
      {relation.description && <p className="mt-3 text-sm text-foreground/90 whitespace-pre-wrap">{relation.description}</p>}
      {relation.docMd && <div className="mt-2 text-sm"><DescriptionSection markdown={relation.docMd} defaultOpen={!relation.description} /></div>}
      {columns.length > 0 && (
        <>
          <SectionTitle>Columns</SectionTitle>
          <ColumnList
            columns={columns}
            primaryKey={relation.primaryKey}
            onInsertText={onInsertText}
            profile={relation.kind === "table" ? { catalog: relation.catalog, schema: relation.schema, table: relation.name } : undefined}
          />
        </>
      )}
      <ExampleQueries
        exampleQueriesJson={relation.source.tags?.[TAG_EXAMPLE_QUERIES]}
        queries={parseExecutableExamples(relation.source.tags ?? {})}
        onOpenShell={() => {}}
      />
    </div>
  );
}
