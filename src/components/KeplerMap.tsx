/**
 * Kepler.gl map component with isolated Redux store.
 * Uses our VgiDuckDBAdapter so kepler.gl's native DuckDB integration
 * (SQL panel, schema browser, data pipeline) can query all VGI tables.
 */
import { useEffect, useRef, useState } from "react";
import { Provider, useSelector, useDispatch } from "react-redux";
import { createStore, combineReducers, applyMiddleware, compose } from "redux";
import keplerGlReducer, { enhanceReduxMiddleware, uiStateUpdaters } from "@kepler.gl/reducers";
import { addDataToMap } from "@kepler.gl/actions";
import { removeDataset } from "@kepler.gl/actions";
import { initApplicationConfig, getApplicationConfig } from "@kepler.gl/utils";
import { VgiDuckDBAdapter } from "@/lib/vgi-duckdb-adapter";

let KeplerGl: any = null;
let keplerStore: any = null;
let configInitialized = false;

function getStore() {
  if (keplerStore) return keplerStore;
  const { DEFAULT_MAP_CONTROLS } = uiStateUpdaters;
  const reducer = combineReducers({
    keplerGl: keplerGlReducer.initialState({
      uiState: {
        currentModal: null,
        activeSidePanel: 'layer', // skip dataset panel, go straight to layers
        mapControls: {
          ...DEFAULT_MAP_CONTROLS,
        },
      },
      visState: {
        loaders: [],
        loadOptions: {},
      },
    }),
  });
  const middlewares = enhanceReduxMiddleware([]);
  keplerStore = createStore(reducer, {}, compose(applyMiddleware(...middlewares)));
  return keplerStore;
}

// Track which datasets are loading or have been loaded
const loadingDatasets = new Set<string>();
const loadedDatasets = new Set<string>();
// Store DuckDB column types per table for arrowSchemaToFields hints
const tableDuckDBTypes = new Map<string, Record<string, string>>();
// Track geometry columns per table (populated during stub registration)
const tableGeomColumns = new Map<string, string[]>();

interface LoadCallbacks {
  onProgress?: (pct: number) => void;
  onDone?: (label: string, rowCount: number) => void;
  onError?: (error: string) => void;
}

/** Fetch full data for a deferred dataset, then dispatch addDataToMap to replace the stub. */
async function loadDeferredDataset(datasetId: string, sourceQuery: string, dispatch: any, callbacks?: LoadCallbacks) {
  if (loadingDatasets.has(datasetId)) return;
  loadingDatasets.add(datasetId);

  // Subscribe to worker progress
  const prevProgress = (window as any).__duckdbProgress;
  if (callbacks?.onProgress) {
    (window as any).__duckdbProgress = callbacks.onProgress;
  }

  try {
    // Get raw Arrow IPC buffer from worker
    const queryFn = (window as any).__duckdbQuery;
    if (!queryFn) return;
    const result = await queryFn(`SELECT * FROM ${sourceQuery}`);
    if (!result.ok || !result.arrowBuffers?.length) {
      throw new Error(result.error || "No data returned");
    }

    const { arrowSchemaToFields } = await import("@kepler.gl/processors");
    const { tableFromIPC } = await import("apache-arrow");
    const arrowTable = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));

    const duckTypes = tableDuckDBTypes.get(datasetId) || {};
    const fields = arrowSchemaToFields(arrowTable, duckTypes);
    const cols = [...Array(arrowTable.numCols).keys()].map(i => arrowTable.getChildAt(i));

    const label = datasetId.replace(/"/g, "").split(".").reverse().join(".");

    dispatch(removeDataset(datasetId));
    dispatch(
      addDataToMap({
        datasets: [{
          info: { id: datasetId, label, format: 'arrow' },
          data: {
            fields,
            rows: [],
            cols,
            arrowTable,
            metadata: arrowTable.schema.metadata,
            arrowSchema: arrowTable.schema,
          },
        }],
      })
    );

    loadedDatasets.add(datasetId);
    callbacks?.onDone?.(label, arrowTable.numRows);
    console.log(`[KeplerMap] Loaded ${arrowTable.numRows} rows for ${label}`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    callbacks?.onError?.(msg);
    console.error(`[KeplerMap] Failed to load ${datasetId}:`, e);
  } finally {
    (window as any).__duckdbProgress = prevProgress;
    loadingDatasets.delete(datasetId);
  }
}

let stubsRegistered = false;

/** Discover VGI tables and register stub datasets (schema only, no row data).
 *  Uses a single duckdb_columns() call to get all column info, then groups by table. */
async function registerStubDatasets(dispatch: any) {
  if (stubsRegistered) return;
  stubsRegistered = true;

  try {
    const db = getApplicationConfig().database;
    if (!db) return;

    const conn = await db.connect();
    const { arrowSchemaToFields } = await import("@kepler.gl/processors");

    // Get columns for VGI catalog + memory only
    const catalogName = (window as any).__duckdbCatalogName || "memory";
    const colResult = await conn.query(
      `SELECT database_name, schema_name, table_name, column_name, data_type
       FROM duckdb_columns()
       WHERE database_name IN ('${catalogName}', 'memory')
       ORDER BY database_name, schema_name, table_name, column_index`
    );
    const numRows = colResult.numRows;
    const colDbs = colResult.getChildAt(0);
    const colSchemas = colResult.getChildAt(1);
    const colTables = colResult.getChildAt(2);
    const colNames = colResult.getChildAt(3);
    const colTypes = colResult.getChildAt(4);

    // Group columns by table
    const tableColumns = new Map<string, { displayName: string; columns: { name: string; type: string }[] }>();
    for (let i = 0; i < numRows; i++) {
      const dbName = String(colDbs?.get(i) ?? "");
      const schema = String(colSchemas?.get(i) ?? "");
      const table = String(colTables?.get(i) ?? "");
      const qualifiedName = `"${dbName}"."${schema}"."${table}"`;

      if (!tableColumns.has(qualifiedName)) {
        tableColumns.set(qualifiedName, {
          displayName: `${table}.${schema}.${dbName}`,
          columns: [],
        });
      }
      tableColumns.get(qualifiedName)!.columns.push({
        name: String(colNames?.get(i) ?? ""),
        type: String(colTypes?.get(i) ?? "VARCHAR"),
      });
    }

    // Build all stub datasets, then dispatch once (not 74 separate dispatches)
    const stubDatasets: any[] = [];
    for (const [qualifiedName, { displayName, columns }] of tableColumns) {
      const typeMap: Record<string, string> = {};
      for (const col of columns) typeMap[col.name] = col.type;
      tableDuckDBTypes.set(qualifiedName, typeMap);

      const fields = columns.map((col) => {
        const t = col.type.toUpperCase();
        let type = "string";
        if (t === "GEOMETRY") type = "geoarrow";
        else if (t.includes("INT") || t === "DOUBLE" || t === "FLOAT" || t.startsWith("DECIMAL")) type = "real";
        else if (t === "BOOLEAN") type = "boolean";
        else if (t === "DATE") type = "date";
        else if (t.startsWith("TIMESTAMP")) type = "timestamp";
        return { name: col.name, type, format: "" };
      });

      stubDatasets.push({
        info: {
          id: qualifiedName,
          label: displayName,
          metadata: { deferred: true, sourceQuery: qualifiedName },
        },
        data: { fields, rows: [] },
      });
    }

    // Single dispatch for all datasets
    dispatch(
      addDataToMap({
        datasets: stubDatasets,
        options: { autoCreateLayers: false, centerMap: false },
      })
    );
    const count = stubDatasets.length;

    await conn.close();
    console.log(`[KeplerMap] Registered ${count} stub datasets from 1 query`);
  } catch (e) {
    console.error("[KeplerMap] Failed to register stubs:", e);
    stubsRegistered = false;
  }
}

function KeplerMapInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const dispatch = useDispatch();
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [loadingTable, setLoadingTable] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadCallbacks: LoadCallbacks = {
    onProgress: (pct) => setLoadProgress(pct),
    onDone: (label, rowCount) => {
      setLoadingTable(null);
      setLoadProgress(0);
    },
    onError: (error) => {
      setLoadingTable(null);
      setLoadProgress(0);
      setLoadError(error);
      setTimeout(() => setLoadError(null), 5000);
    },
  };

  // Register stub datasets on mount
  useEffect(() => {
    registerStubDatasets(dispatch);
  }, [dispatch]);

  // Watch for new layers — only re-run when layer count changes (not on every map interaction)
  const layerCount = useSelector((state: any) => state?.keplerGl?.map?.visState?.layers?.length ?? 0);

  useEffect(() => {
    if (layerCount === 0) return;
    const { keplerGl } = getStore().getState();
    const layers = keplerGl?.map?.visState?.layers;
    const datasets = keplerGl?.map?.visState?.datasets;
    if (!layers || !datasets) return;

    for (const layer of layers) {
      const dataId = layer?.config?.dataId;
      if (!dataId || !dataId.startsWith('"')) continue;
      if (loadedDatasets.has(dataId) || loadingDatasets.has(dataId)) continue;
      const dataset = datasets[dataId];
      if (!dataset) continue;
      if ((dataset.dataContainer?.numRows?.() ?? 0) === 0) {
        const label = dataId.replace(/"/g, "").split(".").reverse().join(".");
        setLoadingTable(label);
        setLoadProgress(0);
        loadDeferredDataset(dataId, dataId, dispatch, loadCallbacks);
      }
    }
  }, [layerCount, dispatch]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setDims({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  /** Handle drop from sidebar tree — parse tree ID and add as layer. */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const treeId = e.dataTransfer.getData("text/plain");
    if (!treeId) return;
    // Tree IDs: "catalogName::schemaName::t:tableName"
    const parts = treeId.split("::");
    if (parts.length !== 3 || !parts[2].startsWith("t:")) return;
    const [catalog, schema, rest] = parts;
    const table = rest.slice(2);
    const qualifiedName = `"${catalog}"."${schema}"."${table}"`;

    // If not already a dataset, register stub + load
    const state = getStore().getState();
    const datasets = state?.keplerGl?.map?.visState?.datasets;
    if (!datasets?.[qualifiedName] && !loadingDatasets.has(qualifiedName) && !loadedDatasets.has(qualifiedName)) {
      // Register stub first
      const duckTypes = tableDuckDBTypes.get(qualifiedName);
      const fields = duckTypes
        ? Object.entries(duckTypes).map(([name, type]) => {
            const t = type.toUpperCase();
            let ft = "string";
            if (t === "GEOMETRY") ft = "geoarrow";
            else if (t.includes("INT") || t === "DOUBLE" || t === "FLOAT" || t.startsWith("DECIMAL")) ft = "real";
            else if (t === "BOOLEAN") ft = "boolean";
            else if (t === "DATE") ft = "date";
            else if (t.startsWith("TIMESTAMP")) ft = "timestamp";
            return { name, type: ft, format: "" };
          })
        : [{ name: "unknown", type: "string", format: "" }];

      dispatch(
        addDataToMap({
          datasets: [{
            info: { id: qualifiedName, label: `${table}.${schema}.${catalog}` },
            data: { fields, rows: [] },
          }],
          options: { autoCreateLayers: false, centerMap: false },
        })
      );
    }

    // Load data — addDataToMap in loadDeferredDataset will auto-create the layer
    if (!loadedDatasets.has(qualifiedName) && !loadingDatasets.has(qualifiedName)) {
      setLoadingTable(`${table}.${schema}`);
      setLoadProgress(0);
      loadDeferredDataset(qualifiedName, qualifiedName, dispatch, loadCallbacks);
    }
  };

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={handleDrop}
    >
      <KeplerGl
        id="map"
        width={dims.width}
        height={dims.height}
        mapboxApiAccessToken=""
      />

      {/* Loading overlay */}
      {loadingTable && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 pointer-events-none">
          <div className="bg-white rounded-lg shadow-xl px-8 py-6 flex flex-col items-center gap-3 min-w-[280px]">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
            <div className="text-sm font-medium text-foreground">
              Loading {loadingTable}
            </div>
            <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
              <div
                className="bg-primary h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(loadProgress, 2)}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {loadProgress > 0 ? `${Math.round(loadProgress)}%` : "Starting..."}
            </div>
          </div>
        </div>
      )}

      {/* Error toast */}
      {loadError && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-destructive text-white px-4 py-2 rounded-md shadow-lg text-sm">
          Failed to load: {loadError}
        </div>
      )}
    </div>
  );
}

export function KeplerMap() {
  const [ready, setReady] = useState(!!KeplerGl);
  const [error, setError] = useState<string | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        const [keplerComponents, duckdbModule] = await Promise.all([
          import("@kepler.gl/components"),
          import("@kepler.gl/duckdb"),
        ]);

        KeplerGl = keplerComponents.default || keplerComponents.KeplerGl;

        if (!configInitialized) {
          // Use default KeplerTable (not KeplerGlDuckDbTable) — our adapter provides
          // direct Arrow query results, we don't need DuckDB import/export pipeline
          initApplicationConfig({
            database: new VgiDuckDBAdapter(),
            plugins: [duckdbModule.keplerGlDuckDBPlugin || { name: "duckdb", init() {} }],
            useArrowProgressiveLoading: false,
            escapeXhtmlForWebpack: false,
          });
          configInitialized = true;
        }

        getStore();
        setReady(true);
      } catch (e: any) {
        console.error("Kepler.gl init error:", e);
        setError(e.message || "Failed to load Kepler.gl");
      }
    })();
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm bg-white">
        {error}
      </div>
    );
  }

  if (!ready || !KeplerGl) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm bg-white">
        Loading Kepler.gl...
      </div>
    );
  }

  return (
    <Provider store={getStore()}>
      <KeplerMapInner />
    </Provider>
  );
}
