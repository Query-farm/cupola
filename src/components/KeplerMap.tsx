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
import { initApplicationConfig } from "@kepler.gl/utils";
import { VgiDuckDBAdapter, VgiDuckDBConnection } from "@/lib/vgi-duckdb-adapter";

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

let tablesLoaded = false;

/** Auto-register VGI tables as kepler.gl datasets so layers can be added immediately. */
async function loadVgiTables(dispatch: any) {
  if (tablesLoaded) return;
  tablesLoaded = true;

  try {
    const conn = new VgiDuckDBConnection();
    const { tableFromIPC } = await import("apache-arrow");
    const { processArrowBatches } = await import("@kepler.gl/processors");

    // Get all tables with geometry columns from the VGI catalog
    const tablesResult = await conn.query(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_catalog = current_catalog() AND table_type = 'BASE TABLE'
       ORDER BY table_schema, table_name`
    );

    const schemas = new Map<string, string[]>();
    for (let i = 0; i < tablesResult.numRows; i++) {
      const schema = String(tablesResult.getChildAt(0)?.get(i));
      const table = String(tablesResult.getChildAt(1)?.get(i));
      if (!schemas.has(schema)) schemas.set(schema, []);
      schemas.get(schema)!.push(table);
    }

    // Load each table that has a geometry column (limit rows for performance)
    for (const [schema, tables] of schemas) {
      for (const table of tables) {
        try {
          // Check if table has geometry column
          const colResult = await conn.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = '${schema}' AND table_name = '${table}'
             AND data_type = 'GEOMETRY' LIMIT 1`
          );
          if (colResult.numRows === 0) continue;

          // Load a sample
          const dataResult = await conn.query(
            `SELECT * FROM "${schema}"."${table}" LIMIT 2000`
          );
          const arrowTable = tableFromIPC(
            (await (window as any).__duckdbQuery(
              `SELECT * FROM "${schema}"."${table}" LIMIT 2000`
            )).arrowBuffers[0]
          );
          const data = processArrowBatches(arrowTable.batches);

          dispatch(
            addDataToMap({
              datasets: {
                info: { label: `${schema}.${table}`, id: `${schema}_${table}` },
                data,
              },
              option: { centerMap: false, readOnly: false },
            })
          );
        } catch (e) {
          console.warn(`[KeplerMap] Skipping ${schema}.${table}:`, (e as Error).message);
        }
      }
    }
  } catch (e) {
    console.error("[KeplerMap] Failed to load VGI tables:", e);
  }
}

function KeplerMapInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const dispatch = useDispatch();
  const [dims, setDims] = useState({ width: 800, height: 600 });

  const isSqlPanelOpen = useSelector((state: any) =>
    state?.keplerGl?.map?.uiState?.mapControls?.sqlPanel?.active
  );

  // Auto-load VGI tables with geometry as datasets
  useEffect(() => {
    loadVgiTables(dispatch);
  }, [dispatch]);

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
