import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Columns3,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  Minus,
  Network,
  Plus,
  Search,
  Table2,
} from "lucide-react";
import type { CatalogData } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import {
  buildCatalogRelationshipGraph,
  catalogRelationshipTableId,
  scopeCatalogRelationshipGraph,
  type CatalogRelationship,
  type CatalogRelationshipTable,
} from "@/lib/catalog-relationships";
import { ui } from "@/lib/shell-bridge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface Props {
  catalog: CatalogData;
  initialSchema?: string;
  initialFocusTable?: string;
  onNavigate: (selection: Selection) => void;
}

interface PositionedTable {
  table: CatalogRelationshipTable;
  columns: CatalogRelationshipTable["columns"];
  columnIndicator?: {
    label: string;
    description: string;
  };
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_WIDTH = 286;
const HEADER_HEIGHT = 58;
const ROW_HEIGHT = 28;
const X_GAP = 150;
const Y_GAP = 54;

function layoutTables(tables: CatalogRelationshipTable[], relationships: CatalogRelationship[], keysOnly: boolean): PositionedTable[] {
  const ids = new Set(tables.map((table) => table.id));
  const incoming = new Map(tables.map((table) => [table.id, 0]));
  const outgoing = new Map(tables.map((table) => [table.id, [] as string[]]));
  for (const relationship of relationships) {
    if (!ids.has(relationship.sourceTableId) || !ids.has(relationship.targetTableId)) continue;
    outgoing.get(relationship.sourceTableId)?.push(relationship.targetTableId);
    incoming.set(relationship.targetTableId, (incoming.get(relationship.targetTableId) ?? 0) + 1);
  }

  // FK edges run child → parent. A longest-path topological layout puts
  // detail tables first and their referenced tables in successive columns.
  const layers = new Map<string, number>();
  const queue = tables.filter((table) => incoming.get(table.id) === 0).map((table) => table.id);
  for (const id of queue) layers.set(id, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    const layer = layers.get(id) ?? 0;
    for (const target of outgoing.get(id) ?? []) {
      layers.set(target, Math.max(layers.get(target) ?? 0, layer + 1));
      const remaining = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  // Put members of a cyclic FK group in the same first column.
  for (const table of tables) if (!layers.has(table.id)) layers.set(table.id, 0);

  const byLayer = new Map<number, CatalogRelationshipTable[]>();
  for (const table of tables) {
    const layer = layers.get(table.id) ?? 0;
    const group = byLayer.get(layer) ?? [];
    group.push(table);
    byLayer.set(layer, group);
  }

  const result: PositionedTable[] = [];
  for (const [layer, group] of [...byLayer].sort(([a], [b]) => a - b)) {
    group.sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
    let y = 24;
    for (const table of group) {
      const important = new Set([...table.primaryKeyColumns, ...table.foreignKeyColumns, ...table.referencedColumns]);
      const filtered = keysOnly ? table.columns.filter((column) => important.has(column.name)) : table.columns;
      const columns = filtered.length > 0 ? filtered : table.columns.slice(0, 4);
      let columnIndicator: PositionedTable["columnIndicator"];
      if (keysOnly && filtered.length > 0 && columns.length < table.columns.length) {
        columnIndicator = {
          label: `${columns.length} of ${table.columns.length}`,
          description: `Showing ${columns.length} relationship and key columns out of ${table.columns.length} total. Choose All columns to show the complete schema.`,
        };
      } else if (keysOnly && filtered.length === 0 && columns.length < table.columns.length) {
        columnIndicator = {
          label: `Preview ${columns.length} of ${table.columns.length}`,
          description: `This table has no relationship or key columns in the current graph, so the first ${columns.length} of ${table.columns.length} columns are shown as a preview. Choose All columns to show the complete schema.`,
        };
      }
      const height = HEADER_HEIGHT + columns.length * ROW_HEIGHT;
      result.push({ table, columns, columnIndicator, x: 24 + layer * (NODE_WIDTH + X_GAP), y, width: NODE_WIDTH, height });
      y += height + Y_GAP;
    }
  }
  return result;
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualified(table: CatalogRelationshipTable): string {
  return [table.catalog, table.schema, table.name].map(quoted).join(".");
}

function joinSql(relationship: CatalogRelationship, tables: Map<string, CatalogRelationshipTable>): string | null {
  const source = tables.get(relationship.sourceTableId);
  const target = tables.get(relationship.targetTableId);
  if (!source || !target) return null;
  const predicates = relationship.sourceColumns.map((column, index) =>
    `source.${quoted(column)} = target.${quoted(relationship.targetColumns[index] ?? relationship.targetColumns[0] ?? column)}`
  );
  return `SELECT *\nFROM ${qualified(source)} AS source\nJOIN ${qualified(target)} AS target\n  ON ${predicates.join("\n AND ")}\nLIMIT 100;`;
}

function columnY(node: PositionedTable, name: string): number {
  const index = Math.max(0, node.columns.findIndex((column) => column.name === name));
  return node.y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function edgePath(source: PositionedTable, target: PositionedTable, relationship: CatalogRelationship): string {
  const x1 = source.x + source.width;
  const y1 = columnY(source, relationship.sourceColumns[0] ?? "");
  const x2 = target.x;
  const y2 = columnY(target, relationship.targetColumns[0] ?? "");
  const bend = x1 < x2 ? Math.max(40, (x2 - x1) / 2) : 70;
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function RelationshipCard({ node, selected, onOpen, onFocus }: {
  node: PositionedTable;
  selected: boolean;
  onOpen: (table: CatalogRelationshipTable) => void;
  onFocus: (table: CatalogRelationshipTable) => void;
}) {
  const { table, columns } = node;
  const primary = new Set(table.primaryKeyColumns);
  const foreign = new Set(table.foreignKeyColumns);
  return (
    <div
      className={`absolute overflow-hidden rounded-xl border bg-card text-card-foreground shadow-md ${selected ? "border-primary ring-2 ring-primary/20" : "border-border"} ${table.external ? "border-dashed" : ""}`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      data-testid={`relationship-node-${table.schema}-${table.name}`}
      onDoubleClick={() => onOpen(table)}
    >
      <div className="flex h-[58px] items-start gap-2 border-b border-border bg-muted/45 px-3 py-2">
        <Table2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onFocus(table)}>
          <span className="block truncate text-[11px] text-muted-foreground">{table.catalog}.{table.schema}</span>
          <span className="block truncate font-mono text-sm font-semibold" title={`${table.schema}.${table.name}`}>{table.name}</span>
        </button>
        {node.columnIndicator ? (
          <Badge
            variant="outline"
            className="shrink-0 px-1.5 text-[9px] font-normal text-muted-foreground"
            title={node.columnIndicator.description}
            aria-label={node.columnIndicator.description}
          >
            {node.columnIndicator.label}
          </Badge>
        ) : null}
        {table.external ? <Badge variant="outline" className="text-[9px]">external</Badge> : (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open ${table.schema}.${table.name}`}
            title="Open table"
            onClick={() => onOpen(table)}
          ><ExternalLink className="h-3.5 w-3.5" /></button>
        )}
      </div>
      {columns.map((column) => (
        <div key={column.name} className="flex h-7 items-center gap-2 border-b border-border/50 px-3 last:border-b-0">
          <span className="flex w-7 shrink-0 items-center gap-0.5 text-amber-600 dark:text-amber-400">
            {primary.has(column.name) ? <KeyRound className="h-3 w-3" aria-label="Primary key" /> : null}
            {foreign.has(column.name) ? <span className="text-[9px] font-bold" title="Foreign key">FK</span> : null}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={column.name}>{column.name}</span>
          <span className="max-w-24 truncate font-mono text-[10px] text-muted-foreground" title={column.duckdbType}>{column.duckdbType}</span>
        </div>
      ))}
    </div>
  );
}

export function CatalogRelationships({ catalog, initialSchema, initialFocusTable, onNavigate }: Props) {
  const graph = useMemo(() => buildCatalogRelationshipGraph(catalog), [catalog]);
  const initialFocusId = initialSchema && initialFocusTable
    ? catalogRelationshipTableId(catalog.catalogName, initialSchema, initialFocusTable)
    : undefined;
  const [schema, setSchema] = useState(initialSchema ?? (graph.tables.length > 60 ? catalog.defaultSchema ?? "all" : "all"));
  const [focusTableId, setFocusTableId] = useState<string | undefined>(initialFocusId);
  const [depth, setDepth] = useState(1);
  const [search, setSearch] = useState("");
  const [keysOnly, setKeysOnly] = useState(true);
  const [showIsolated, setShowIsolated] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<string>();
  const viewportRef = useRef<HTMLDivElement>(null);

  const scoped = useMemo(() => scopeCatalogRelationshipGraph(graph, {
    schema, focusTableId, depth, search, showIsolated,
  }), [graph, schema, focusTableId, depth, search, showIsolated]);
  const nodes = useMemo(() => layoutTables(scoped.tables, scoped.relationships, keysOnly), [scoped, keysOnly]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.table.id, node])), [nodes]);
  const tableMap = useMemo(() => new Map(graph.tables.map((table) => [table.id, table])), [graph.tables]);
  const width = Math.max(640, ...nodes.map((node) => node.x + node.width + 24));
  const height = Math.max(400, ...nodes.map((node) => node.y + node.height + 24));
  const selectedRelationship = graph.relationships.find((relationship) => relationship.id === selectedRelationshipId);

  const openTable = useCallback((table: CatalogRelationshipTable) => {
    if (!table.external) onNavigate({ type: "table", name: table.name, schema: table.schema, catalog: table.catalog });
  }, [onNavigate]);

  const fitDiagram = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || nodes.length === 0) return;
    const scale = Math.min((viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height);
    setZoom(Math.min(1, Math.max(0.25, scale)));
    viewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  }, [height, nodes.length, width]);

  useEffect(() => { const id = requestAnimationFrame(fitDiagram); return () => cancelAnimationFrame(id); }, [fitDiagram]);

  const openJoin = () => {
    if (!selectedRelationship) return;
    const sql = joinSql(selectedRelationship, tableMap);
    if (sql) ui.openInEditor?.(sql, { autoRun: false });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="catalog-relationships">
      <header className="shrink-0 border-b border-border bg-card px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" aria-label="Back to catalog details" onClick={() => onNavigate(initialSchema
            ? { type: "schema", name: initialSchema, schema: initialSchema, catalog: catalog.catalogName }
            : { type: "catalog", name: catalog.catalogName, catalog: catalog.catalogName })}
          ><ArrowLeft /></Button>
          <Network className="h-5 w-5 text-primary" />
          <div className="mr-auto min-w-0">
            <h1 className="truncate text-base font-semibold">Relationships</h1>
            <p className="text-xs text-muted-foreground">{scoped.relationships.length} declared foreign keys across {scoped.tables.length} tables</p>
          </div>
          <div className="relative w-44 max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(event) => { setSearch(event.target.value); setFocusTableId(undefined); }} placeholder="Find a table…" aria-label="Find a table" className="pl-8" />
          </div>
          <label className="sr-only" htmlFor="relationship-schema">Schema</label>
          <select id="relationship-schema" className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={schema} onChange={(event) => { setSchema(event.target.value); setFocusTableId(undefined); }}>
            <option value="all">All schemas</option>
            {catalog.schemas.map((item) => <option key={item.info.name} value={item.info.name}>{item.info.name}</option>)}
          </select>
          <label className="sr-only" htmlFor="relationship-depth">Relationship depth</label>
          <select id="relationship-depth" className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={depth} disabled={!focusTableId && !search} onChange={(event) => setDepth(Number(event.target.value))}>
            <option value={1}>1 hop</option><option value={2}>2 hops</option><option value={3}>3 hops</option>
          </select>
          <Button variant={keysOnly ? "secondary" : "outline"} onClick={() => setKeysOnly((value) => !value)}><KeyRound /> {keysOnly ? "Keys only" : "All columns"}</Button>
          <Button variant={showIsolated ? "secondary" : "outline"} onClick={() => setShowIsolated((value) => !value)}><Columns3 /> Unrelated</Button>
        </div>
        {focusTableId ? <div className="mt-2 text-xs text-muted-foreground">Focused on <strong className="font-mono text-foreground">{tableMap.get(focusTableId)?.name}</strong> and {depth}-hop neighbors. <button type="button" className="text-primary hover:underline" onClick={() => setFocusTableId(undefined)}>Show schema</button></div> : null}
        {scoped.truncated ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Showing the first {scoped.tables.length} of {scoped.totalCandidates} tables. Focus or search to narrow the graph.</p> : null}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={viewportRef} className="absolute inset-0 overflow-auto bg-muted/20" onClick={() => setSelectedRelationshipId(undefined)}>
          {nodes.length > 0 ? (
          <div className="relative" style={{ width: width * zoom, height: height * zoom }}>
            <div className="absolute left-0 top-0 origin-top-left" style={{ width, height, transform: `scale(${zoom})` }}>
              <svg className="absolute inset-0 overflow-visible" width={width} height={height} aria-label="Foreign key relationships">
                <defs><marker id="relationship-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" className="fill-primary/70" /></marker></defs>
                {scoped.relationships.map((relationship) => {
                  const source = nodeMap.get(relationship.sourceTableId);
                  const target = nodeMap.get(relationship.targetTableId);
                  if (!source || !target) return null;
                  const path = edgePath(source, target, relationship);
                  const label = `${source.table.name}.${relationship.sourceColumns.join(", ")} references ${target.table.name}.${relationship.targetColumns.join(", ")}`;
                  const active = relationship.id === selectedRelationshipId;
                  return <g key={relationship.id} onClick={(event) => { event.stopPropagation(); setSelectedRelationshipId(relationship.id); }} role="button" tabIndex={0} aria-label={label} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedRelationshipId(relationship.id); }}>
                    <path d={path} fill="none" stroke="transparent" strokeWidth="14" className="cursor-pointer" />
                    <path d={path} fill="none" className={active ? "stroke-primary" : "stroke-primary/55"} strokeWidth={active ? 2.5 : 1.5} markerEnd="url(#relationship-arrow)" />
                    <title>{label}</title>
                  </g>;
                })}
              </svg>
              {nodes.map((node) => <RelationshipCard key={node.table.id} node={node} selected={node.table.id === focusTableId} onOpen={openTable} onFocus={(table) => { setSchema(table.schema); setFocusTableId(table.id); setSearch(""); }} />)}
            </div>
          </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center p-6"><div className="max-w-md rounded-xl border border-dashed border-border bg-card p-8 text-center"><Network className="mx-auto mb-3 h-9 w-9 text-muted-foreground" /><h2 className="font-semibold">No declared relationships in this view</h2><p className="mt-1 text-sm text-muted-foreground">Cupola only draws database-declared foreign keys, so suggested matches cannot be mistaken for facts.</p>{!showIsolated ? <Button className="mt-4" variant="outline" onClick={() => setShowIsolated(true)}>Show tables anyway</Button> : null}</div></div>
          )}
        </div>

        <div className="absolute bottom-3 left-3 z-20 flex items-center rounded-lg border border-border bg-card shadow-sm">
          <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.25, value - 0.1))}><Minus /></Button>
          <span className="w-12 text-center text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}><Plus /></Button>
          <span className="h-5 w-px bg-border" />
          <Button variant="ghost" size="icon" aria-label="Fit relationship layout" title="Fit layout" onClick={fitDiagram}><LayoutDashboard /></Button>
        </div>
        {selectedRelationship ? <div className="absolute bottom-3 left-1/2 z-20 flex w-fit max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur" onClick={(event) => event.stopPropagation()}><div className="min-w-0"><div className="truncate font-medium">{tableMap.get(selectedRelationship.sourceTableId)?.name}.{selectedRelationship.sourceColumns.join(", ")} <span className="mx-1 text-muted-foreground">→</span> {tableMap.get(selectedRelationship.targetTableId)?.name}.{selectedRelationship.targetColumns.join(", ")}</div><div className="text-muted-foreground">{selectedRelationship.constraintName || "Foreign key"} · {selectedRelationship.oneToOne ? "one-to-one" : selectedRelationship.optional ? "optional many-to-one" : "many-to-one"}</div></div><Button size="sm" onClick={openJoin} disabled={!ui.openInEditor}>Create JOIN query</Button></div> : null}
      </div>
    </div>
  );
}
