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

/** Fetch full data for a deferred dataset, then dispatch addDataToMap to replace the stub. */
async function loadDeferredDataset(datasetId: string, sourceQuery: string, dispatch: any) {
  if (loadingDatasets.has(datasetId)) return;
  loadingDatasets.add(datasetId);

  try {
    console.log(`[KeplerMap] Loading deferred dataset: ${datasetId}`);

    // Get raw Arrow IPC buffer directly from worker — bypass our adapter's
    // tableFromIPC to avoid Arrow version conflict with kepler.gl's bundled Arrow
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
    // Extract column vectors — this is what processArrowBatches returns
    const cols = [...Array(arrowTable.numCols).keys()].map(i => arrowTable.getChildAt(i));

    const label = datasetId.replace(/"/g, "").split(".").slice(1).join(".");
    console.log(`[KeplerMap] Parsed ${arrowTable.numRows} rows, fields:`, fields.map((f: any) => `${f.name}:${f.type}`));

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
    console.log(`[KeplerMap] Loaded ${arrowTable.numRows} rows for ${label}`);
  } catch (e) {
    console.error(`[KeplerMap] Failed to load ${datasetId}:`, e);
  } finally {
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

    // Single query to get all columns for all tables
    const colResult = await conn.query(
      "SELECT database_name, schema_name, table_name, column_name, data_type FROM duckdb_columns() ORDER BY database_name, schema_name, table_name, column_index"
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
          displayName: `${schema}.${table}`,
          columns: [],
        });
      }
      tableColumns.get(qualifiedName)!.columns.push({
        name: String(colNames?.get(i) ?? ""),
        type: String(colTypes?.get(i) ?? "VARCHAR"),
      });
    }

    // Register each table as a stub dataset and save DuckDB types for later use.
    let count = 0;
    for (const [qualifiedName, { displayName, columns }] of tableColumns) {
      // Save DuckDB types for arrowSchemaToFields when data loads
      const typeMap: Record<string, string> = {};
      for (const col of columns) typeMap[col.name] = col.type;
      tableDuckDBTypes.set(qualifiedName, typeMap);
      // Log first table's types for debugging
      if (count === 0) console.log(`[KeplerMap] Sample types for ${displayName}:`, typeMap);

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

      dispatch(
        addDataToMap({
          datasets: [{
            info: {
              id: qualifiedName,
              label: displayName,
              metadata: { deferred: true, sourceQuery: qualifiedName },
            },
            data: {
              fields,
              rows: [],
            },
          }],
          options: {
            autoCreateLayers: false,
            centerMap: false,
          },
        })
      );
      count++;
    }

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

  // Register stub datasets on mount
  useEffect(() => {
    registerStubDatasets(dispatch);
  }, [dispatch]);

  // Watch for layers that reference deferred (stub) datasets and load them
  const layers = useSelector((state: any) => state?.keplerGl?.map?.visState?.layers);
  const datasets = useSelector((state: any) => state?.keplerGl?.map?.visState?.datasets);

  useEffect(() => {
    if (!layers || !datasets) return;
    console.log(`[KeplerMap] Watcher: ${layers.length} layers, ${Object.keys(datasets).length} datasets`);
    for (const layer of layers) {
      const dataId = layer?.config?.dataId;
      if (!dataId) continue;
      const dataset = datasets[dataId];
      if (!dataset) {
        console.log(`[KeplerMap] Layer ${layer.id}: dataset ${dataId} not found`);
        continue;
      }
      const numRows = dataset.dataContainer?.numRows?.() ?? dataset.dataContainer?.length ?? -1;
      console.log(`[KeplerMap] Layer ${layer.id}: dataId=${dataId}, rows=${numRows}`);
      // The dataset ID is the fully qualified table name — use it as the query source
      const isDeferred = numRows === 0 && dataId.startsWith('"') && !loadedDatasets.has(dataId);
      if (isDeferred && !loadingDatasets.has(dataId)) {
        loadDeferredDataset(dataId, dataId, dispatch);
      }
    }
  }, [layers, datasets, dispatch]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setDims({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      <KeplerGl
        id="map"
        width={dims.width}
        height={dims.height}
        mapboxApiAccessToken=""
      />
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
