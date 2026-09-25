import type { CatalogData } from './service';
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

/** A single session inventory. Bootstrap metadata is provisional: once the
 * engine is ready, only databases actually attached to it belong in this list. */
export class CatalogInventory {
  private state: CatalogSnapshot = { catalogs: [], ready: false, refreshing: false, error: null, revision: 0 };
  private listeners = new Set<() => void>();
  private identities = new Map<string, string>();
  private bootstrap: CatalogData | null = null;
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
  seed(catalog: CatalogData, serviceUrl: string) {
    this.bootstrap = { ...catalog, sourceUrl: serviceUrl, databaseType: 'vgi', primary: true };
    if (!this.state.ready) this.publish({ catalogs: [this.bootstrap] });
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
            // Connection context is only known for the original attachment.
            // Never assign the primary service's URL to another catalog alias.
            const initialPrimary = !this.state.ready && db.name === this.bootstrap?.catalogName && db.type === 'vgi';
            const primary = initialPrimary || Boolean(sameAttachment && base?.primary);
            return {
              ...catalog, catalogName: db.name, databaseType: db.type, primary,
              sourceUrl: primary ? this.bootstrap?.sourceUrl : undefined,
              defaultSchema: primary && catalog.schemas.some(s => s.info.name === this.bootstrap?.defaultSchema)
                ? this.bootstrap!.defaultSchema : catalog.defaultSchema,
            };
          }));
          // A mutation during metadata loading makes the entire read stale.
          if (generation !== this.generation) continue;
          this.identities = new Map(databases.map(db => [db.name, db.id]));
          catalogs.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || a.catalogName.localeCompare(b.catalogName));
          this.publish({ catalogs, ready: true, error: null, revision: this.state.revision + 1 });
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
