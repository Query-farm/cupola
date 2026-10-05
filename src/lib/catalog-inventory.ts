import type { CatalogData } from './service';
import type { OptionSpecInfo } from './attach/options';
import { splitStatements, statementKeyword } from './editor/sql-statements';

export interface AttachedDatabase {
  name: string;
  type: string;
  /** Changes on detach/reattach, even when the SQL alias stays the same. */
  id: string;
}
export interface CatalogSnapshot {
  catalogs: CatalogData[];
  ready: boolean;
  refreshing: boolean;
  error: string | null;
  revision: number;
}
interface CatalogSource {
  list(): Promise<AttachedDatabase[]>;
  load(database: AttachedDatabase): Promise<CatalogData>;
}

/** What the app knows about a catalog it attached itself: where it came from
 * and how. Keyed by alias. Never carries a secret value: secret options are
 * named (`secretOptionNames`) so the ConnectBox can write `getenv()` for them. */
export interface CatalogConnection {
  sourceUrl: string;
  /** The catalog's name on the server (the alias may differ). */
  catalogName: string;
  databaseType: string;
  specs?: OptionSpecInfo[];
  /** Non-secret attach options (DuckDB text). */
  attachOptions?: Record<string, string>;
  secretOptionNames?: string[];
  /** Preferred over the catalog's own default schema when it exists. */
  defaultSchema?: string | null;
}

/** A single session inventory. Seeded metadata is provisional: once the
 * engine is ready, only databases actually attached to it belong in this list.
 *
 * Connection context (`sourceUrl`, options, `isDefault`) belongs to the
 * attachment the app made, not to the alias: the first attachment of a
 * configured alias with the expected type is bound to it by database oid, and
 * a later DETACH + ATTACH under the same alias (a different oid) gets none.
 * The app's own Retry clears the binding first (`rebind`). */
export class CatalogInventory {
  private state: CatalogSnapshot = { catalogs: [], ready: false, refreshing: false, error: null, revision: 0 };
  private listeners = new Set<() => void>();
  private identities = new Map<string, string>();
  private connections = new Map<string, CatalogConnection>();
  private bound = new Map<string, string>();
  private defaultAlias: string | null = null;
  private seeds: CatalogData[] = [];
  private active = false;
  private generation = 0;
  private dirty = true;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private source: CatalogSource) {}
  getSnapshot = (): CatalogSnapshot => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<CatalogSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  /** Every catalog the app attaches, in workspace order, and which is the
   *  default. `seeds` are their RPC previews (a Grainlift gateway seeds an
   *  empty placeholder), shown until the engine has attached them. */
  setConnections(connections: ReadonlyMap<string, CatalogConnection>, defaultAlias: string | null, seeds: readonly CatalogData[] = []) {
    this.connections = new Map(connections);
    this.defaultAlias = defaultAlias;
    this.seeds = seeds.map(seed => this.decorate(seed, seed.catalogName, true));
    if (!this.state.ready) this.publish({ catalogs: this.sortCatalogs(this.seeds) });
  }
  /** The default changed (the requested default did not attach, or a Retry
   *  attached it). */
  setDefault(alias: string | null) {
    if (alias === this.defaultAlias) return;
    this.defaultAlias = alias;
    this.publish({ catalogs: this.sortCatalogs(this.state.catalogs.map(c => ({ ...c, isDefault: Boolean(c.sourceUrl) && c.catalogName === alias }))) });
  }
  /** Forget which attachment an alias is bound to, before the app attaches it
   *  again itself (Retry). */
  rebind(alias: string) {
    this.bound.delete(alias);
  }
  connection(alias: string): CatalogConnection | undefined {
    return this.connections.get(alias);
  }
  private decorate(catalog: CatalogData, alias: string, bound: boolean): CatalogData {
    const connection = bound ? this.connections.get(alias) : undefined;
    if (!connection) return { ...catalog, isDefault: false, sourceUrl: undefined };
    return {
      ...catalog,
      databaseType: catalog.databaseType ?? connection.databaseType,
      isDefault: alias === this.defaultAlias,
      sourceUrl: connection.sourceUrl,
      serverCatalogName: connection.catalogName,
      attachOptions: connection.attachOptions,
      attachSpecs: connection.specs,
      secretOptionNames: connection.secretOptionNames,
      defaultSchema: connection.defaultSchema && catalog.schemas.some(s => s.info.name === connection.defaultSchema)
        ? connection.defaultSchema : catalog.defaultSchema,
    };
  }
  /** Default first, then the app's catalogs in workspace order, then the
   *  rest by name. */
  private sortCatalogs(catalogs: CatalogData[]): CatalogData[] {
    const order = [...this.connections.keys()];
    const rank = (c: CatalogData) => c.isDefault ? -1 : c.sourceUrl && order.includes(c.catalogName) ? order.indexOf(c.catalogName) : order.length;
    return [...catalogs].sort((a, b) => rank(a) - rank(b) || a.catalogName.localeCompare(b.catalogName));
  }
  activate = async () => {
    this.active = true;
    await this.refresh();
  };
  invalidate = () => {
    this.dirty = true;
    this.generation++;
    // Coalesce sequences such as report setup DDL. Discovery tools can flush
    // this immediately through current(), without waiting for the timer.
    if (this.active && !this.pending && !this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 50);
  };
  refresh = async (): Promise<void> => {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending) return this.pending;
    this.dirty = true;
    this.pending = this.drain().finally(() => { this.pending = null; });
    return this.pending;
  };
  async current(): Promise<CatalogData[]> {
    if (this.dirty || this.pending) await this.refresh();
    if (this.state.error) throw new Error(`Catalog discovery failed: ${this.state.error}`);
    return this.state.catalogs;
  }
  /** Whether this attachment is the one the app made for its alias. The
   *  first attachment of a configured alias with the expected type is bound by
   *  oid (committed once a read is known not to be stale); any other
   *  attachment under that alias is not. */
  private isBound(db: AttachedDatabase): boolean {
    const connection = this.connections.get(db.name);
    if (!connection || connection.databaseType !== db.type) return false;
    const prior = this.bound.get(db.name);
    return prior === undefined || prior === db.id;
  }
  private async drain() {
    this.publish({ refreshing: true });
    try {
      while (this.dirty) {
        this.dirty = false;
        const generation = this.generation;
        try {
          const databases = (await this.source.list()).filter(db => db.name !== 'system' && db.name !== 'temp');
          const previous = new Map(this.state.catalogs.map(c => [c.catalogName, c]));
          const catalogs = await Promise.all(databases.map(async db => {
            const sameAttachment = this.identities.get(db.name) === db.id;
            const base = sameAttachment ? previous.get(db.name) : undefined;
            let catalog: CatalogData;
            try {
              catalog = await this.source.load(db);
            } catch (error) {
              catalog = { ...(base ?? { catalogName: db.name, catalogComment: null, catalogTags: {}, defaultSchema: null, schemas: [] }), metadataError: error instanceof Error ? error.message : String(error) };
            }
            return this.decorate({ ...catalog, catalogName: db.name, databaseType: db.type }, db.name, this.isBound(db));
          }));
          // A mutation during metadata loading makes the entire read stale.
          if (generation !== this.generation) continue;
          this.identities = new Map(databases.map(db => [db.name, db.id]));
          for (const db of databases) if (this.isBound(db)) this.bound.set(db.name, db.id);
          this.publish({ catalogs: this.sortCatalogs(catalogs), ready: true, error: null, revision: this.state.revision + 1 });
        } catch (error) {
          if (generation !== this.generation) continue;
          this.publish({ error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      this.publish({ refreshing: false });
    }
  }
}

/** Inspect statement starts, not literals/comments or the shape of results.
 * Run after failures too: earlier statements in a SQL batch may have succeeded. */
export function changesCatalog(sql: string): boolean {
  return splitStatements(sql).some(({ text }) =>
    /^(?:ATTACH|DETACH|CREATE|DROP|ALTER|COMMENT|LOAD|IMPORT|COMMIT|END|ROLLBACK|ABORT)$/.test(statementKeyword(text)),
  );
}
