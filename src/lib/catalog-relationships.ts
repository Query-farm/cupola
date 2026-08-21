import { getColumns, getForeignKeys, type CatalogData, type ColumnInfo } from "./service";

export interface CatalogRelationshipTable {
  id: string;
  catalog: string;
  schema: string;
  name: string;
  comment?: string;
  columns: ColumnInfo[];
  primaryKeyColumns: string[];
  foreignKeyColumns: string[];
  referencedColumns: string[];
  external?: boolean;
}

export interface CatalogRelationship {
  id: string;
  kind: "foreign_key";
  constraintName?: string;
  sourceTableId: string;
  sourceColumns: string[];
  targetTableId: string;
  targetColumns: string[];
  optional: boolean;
  oneToOne: boolean;
}

export interface CatalogRelationshipGraph {
  catalog: string;
  tables: CatalogRelationshipTable[];
  relationships: CatalogRelationship[];
}

export interface CatalogRelationshipScope {
  schema?: string;
  focusTableId?: string;
  depth?: number;
  search?: string;
  showIsolated?: boolean;
  maxTables?: number;
}

export interface ScopedCatalogRelationshipGraph extends CatalogRelationshipGraph {
  truncated: boolean;
  totalCandidates: number;
}

export function catalogRelationshipTableId(catalog: string, schema: string, table: string): string {
  return [catalog, schema, table].map(encodeURIComponent).join("/");
}

function keyColumns(indices: number[], columns: ColumnInfo[]): string[] {
  return indices.map((index) => columns[index]?.name).filter((name): name is string => Boolean(name));
}

function sameColumnSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((column) => right.includes(column));
}

export function buildCatalogRelationshipGraph(catalog: CatalogData): CatalogRelationshipGraph {
  const tables = new Map<string, CatalogRelationshipTable>();
  const sourceTables = new Map<string, { columns: ColumnInfo[]; uniqueKeys: string[][] }>();

  for (const schema of catalog.schemas) {
    for (const table of schema.tables) {
      const columns = getColumns(table);
      const primaryKeys = (table.primary_key_constraints ?? []).map((key) => keyColumns(key, columns));
      const uniqueKeys = [
        ...primaryKeys,
        ...(table.unique_constraints ?? []).map((key) => keyColumns(key, columns)),
      ].filter((key) => key.length > 0);
      const id = catalogRelationshipTableId(catalog.catalogName, schema.info.name, table.name);
      tables.set(id, {
        id,
        catalog: catalog.catalogName,
        schema: schema.info.name,
        name: table.name,
        comment: table.comment || undefined,
        columns,
        primaryKeyColumns: [...new Set(primaryKeys.flat())],
        foreignKeyColumns: [],
        referencedColumns: [],
      });
      sourceTables.set(id, { columns, uniqueKeys });
    }
  }

  const relationships: CatalogRelationship[] = [];
  for (const schema of catalog.schemas) {
    for (const table of schema.tables) {
      const sourceId = catalogRelationshipTableId(catalog.catalogName, schema.info.name, table.name);
      const source = tables.get(sourceId);
      const sourceInfo = sourceTables.get(sourceId);
      if (!source || !sourceInfo) continue;
      for (const [index, foreignKey] of getForeignKeys(table).entries()) {
        const targetCatalog = foreignKey.referencedCatalog || catalog.catalogName;
        const targetSchema = foreignKey.referencedSchema || schema.info.name;
        const targetId = catalogRelationshipTableId(targetCatalog, targetSchema, foreignKey.referencedTable);
        let target = tables.get(targetId);
        if (!target) {
          target = {
            id: targetId,
            catalog: targetCatalog,
            schema: targetSchema,
            name: foreignKey.referencedTable,
            columns: foreignKey.referencedColumns.map((name) => ({
              name,
              arrowType: "Unknown",
              duckdbType: "UNKNOWN",
              nullable: false,
            })),
            primaryKeyColumns: foreignKey.referencedColumns,
            foreignKeyColumns: [],
            referencedColumns: foreignKey.referencedColumns,
            external: true,
          };
          tables.set(targetId, target);
        }

        source.foreignKeyColumns.push(...foreignKey.columns);
        target.referencedColumns.push(...foreignKey.referencedColumns);
        const optional = foreignKey.columns.some((column) => sourceInfo.columns.find((candidate) => candidate.name === column)?.nullable ?? true);
        relationships.push({
          id: `${sourceId}:${foreignKey.constraintName || index}:${targetId}`,
          kind: "foreign_key",
          constraintName: foreignKey.constraintName,
          sourceTableId: sourceId,
          sourceColumns: foreignKey.columns,
          targetTableId: targetId,
          targetColumns: foreignKey.referencedColumns,
          optional,
          oneToOne: sourceInfo.uniqueKeys.some((key) => sameColumnSet(key, foreignKey.columns)),
        });
      }
    }
  }

  return {
    catalog: catalog.catalogName,
    tables: [...tables.values()].map((table) => ({
      ...table,
      foreignKeyColumns: [...new Set(table.foreignKeyColumns)],
      referencedColumns: [...new Set(table.referencedColumns)],
    })),
    relationships,
  };
}

function neighbors(graph: CatalogRelationshipGraph): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const relationship of graph.relationships) {
    const source = result.get(relationship.sourceTableId) ?? new Set<string>();
    source.add(relationship.targetTableId);
    result.set(relationship.sourceTableId, source);
    const target = result.get(relationship.targetTableId) ?? new Set<string>();
    target.add(relationship.sourceTableId);
    result.set(relationship.targetTableId, target);
  }
  return result;
}

function expandNeighborhood(seed: Set<string>, adjacency: Map<string, Set<string>>, depth: number): Set<string> {
  const included = new Set(seed);
  let frontier = new Set(seed);
  for (let hop = 0; hop < depth; hop += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!included.has(neighbor)) next.add(neighbor);
      }
    }
    for (const id of next) included.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }
  return included;
}

export function scopeCatalogRelationshipGraph(
  graph: CatalogRelationshipGraph,
  scope: CatalogRelationshipScope = {},
): ScopedCatalogRelationshipGraph {
  const adjacency = neighbors(graph);
  const depth = Math.max(0, scope.depth ?? 1);
  const search = scope.search?.trim().toLocaleLowerCase() ?? "";
  let included: Set<string>;

  if (scope.focusTableId && graph.tables.some((table) => table.id === scope.focusTableId)) {
    included = expandNeighborhood(new Set([scope.focusTableId]), adjacency, depth);
  } else if (search) {
    const matches = graph.tables.filter((table) => `${table.schema}.${table.name}`.toLocaleLowerCase().includes(search));
    included = expandNeighborhood(new Set(matches.map((table) => table.id)), adjacency, Math.max(1, depth));
  } else if (scope.schema && scope.schema !== "all") {
    const schemaTables = new Set(graph.tables.filter((table) => table.schema === scope.schema).map((table) => table.id));
    included = expandNeighborhood(schemaTables, adjacency, 1);
  } else {
    included = new Set(graph.tables.map((table) => table.id));
  }

  if (!scope.showIsolated) {
    const connected = new Set<string>();
    for (const relationship of graph.relationships) {
      if (included.has(relationship.sourceTableId) && included.has(relationship.targetTableId)) {
        connected.add(relationship.sourceTableId);
        connected.add(relationship.targetTableId);
      }
    }
    if (scope.focusTableId && included.has(scope.focusTableId)) connected.add(scope.focusTableId);
    included = connected;
  }

  const candidates = graph.tables
    .filter((table) => included.has(table.id))
    .sort((left, right) => left.schema.localeCompare(right.schema) || left.name.localeCompare(right.name));
  const maxTables = Math.max(1, scope.maxTables ?? 100);
  const visibleTables = candidates.slice(0, maxTables);
  const visibleIds = new Set(visibleTables.map((table) => table.id));
  return {
    catalog: graph.catalog,
    tables: visibleTables,
    relationships: graph.relationships.filter((relationship) => visibleIds.has(relationship.sourceTableId) && visibleIds.has(relationship.targetTableId)),
    truncated: candidates.length > visibleTables.length,
    totalCandidates: candidates.length,
  };
}
