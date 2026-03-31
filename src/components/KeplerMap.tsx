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
import { initApplicationConfig, getApplicationConfig } from "@kepler.gl/utils";
import { VgiDuckDBAdapter } from "@/lib/vgi-duckdb-adapter";

let KeplerGl: any = null;
let SqlPanel: any = null;
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
          sqlPanel: {
            active: true,
            activeMapIndex: 0,
            disableClose: false,
            show: true,
          },
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

// Track which datasets are currently being loaded to avoid duplicate fetches
const loadingDatasets = new Set<string>();

/** Fetch full data for a deferred dataset, then dispatch addDataToMap to replace the stub. */
async function loadDeferredDataset(datasetId: string, sourceQuery: string, dispatch: any) {
  if (loadingDatasets.has(datasetId)) return;
  loadingDatasets.add(datasetId);

  try {
    console.log(`[KeplerMap] Loading deferred dataset: ${datasetId}`);
    const db = getApplicationConfig().database;
    if (!db) return;

    const conn = await db.connect();
    const duckdbUtils = await import("@kepler.gl/duckdb");
    const { arrowSchemaToFields } = await import("@kepler.gl/processors");

    // Get column types for type casting
    const duckDbColumns = await duckdbUtils.getDuckDBColumnTypes(conn, sourceQuery);

    // Cast types for kepler (GEOMETRY → WKB, BIGINT → DOUBLE)
    const castQuery = duckdbUtils.castDuckDBTypesForKepler(sourceQuery, duckDbColumns);
    const arrowTable = await conn.query(castQuery);

    // Set GeoArrow extension metadata
    duckdbUtils.setGeoArrowWKBExtension(arrowTable, duckDbColumns);

    const tableDuckDBTypes = duckdbUtils.getDuckDBColumnTypesMap(duckDbColumns);
    const keplerFields = arrowSchemaToFields(arrowTable, tableDuckDBTypes);

    await conn.close();

    // Replace the stub dataset with real data
    dispatch(
      addDataToMap({
        datasets: [{
          info: {
            id: datasetId,
            label: datasetId.replace(/"/g, '').split('.').slice(1).join('.'),
            format: 'arrow',
          },
          data: {
            fields: keplerFields,
            rows: arrowTable as any,
          },
        }],
      })
    );

    console.log(`[KeplerMap] Loaded ${arrowTable.numRows} rows for ${datasetId}`);
  } catch (e) {
    console.error(`[KeplerMap] Failed to load ${datasetId}:`, e);
  } finally {
    loadingDatasets.delete(datasetId);
  }
}

function KeplerMapInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const dispatch = useDispatch();
  const [dims, setDims] = useState({ width: 800, height: 600 });

  const isSqlPanelOpen = useSelector((state: any) =>
    state?.keplerGl?.map?.uiState?.mapControls?.sqlPanel?.active
  );

  // Watch for layers that reference deferred (stub) datasets and load them
  const layers = useSelector((state: any) => state?.keplerGl?.map?.visState?.layers);
  const datasets = useSelector((state: any) => state?.keplerGl?.map?.visState?.datasets);

  useEffect(() => {
    if (!layers || !datasets) return;
    for (const layer of layers) {
      const dataId = layer?.config?.dataId;
      if (!dataId) continue;
      const dataset = datasets[dataId];
      if (!dataset) continue;
      // Check if this is a deferred stub (0 rows and has sourceQuery metadata)
      const meta = dataset.metadata || dataset.info?.metadata;
      const sourceQuery = meta?.sourceQuery;
      if (sourceQuery && dataset.dataContainer?.numRows() === 0 && !loadingDatasets.has(dataId)) {
        loadDeferredDataset(dataId, sourceQuery, dispatch);
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

  const sqlHeight = isSqlPanelOpen && SqlPanel ? Math.floor(dims.height * 0.4) : 0;
  const mapHeight = dims.height - sqlHeight;

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col">
      <div style={{ height: mapHeight, width: dims.width, position: "relative", overflow: "hidden" }}>
        <KeplerGl
          id="map"
          width={dims.width}
          height={mapHeight}
          mapboxApiAccessToken=""
        />
      </div>
      {isSqlPanelOpen && SqlPanel && (
        <div style={{ height: sqlHeight, width: dims.width, overflow: "hidden" }}>
          <SqlPanel initialSql="" />
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
        // Pre-configure Monaco to use local bundle (CDN AMD loader conflicts with Vite)
        const [monacoLoader, monaco] = await Promise.all([
          import("@monaco-editor/react").then(m => m.loader),
          import("monaco-editor"),
        ]);
        monacoLoader.config({ monaco });

        const [keplerComponents, duckdbModule, duckdbComponents] = await Promise.all([
          import("@kepler.gl/components"),
          import("@kepler.gl/duckdb"),
          import("@kepler.gl/duckdb/components"),
        ]);

        KeplerGl = keplerComponents.default || keplerComponents.KeplerGl;
        SqlPanel = duckdbComponents.SqlPanel;

        if (!configInitialized) {
          initApplicationConfig({
            database: new VgiDuckDBAdapter(),
            table: duckdbModule.KeplerGlDuckDbTable,
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
