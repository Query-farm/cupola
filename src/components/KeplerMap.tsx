/**
 * Kepler.gl map component with isolated Redux store.
 * Uses our VgiDuckDBAdapter so kepler.gl's native DuckDB integration
 * (SQL panel, schema browser, data pipeline) can query all VGI tables.
 */
import { useEffect, useRef, useState } from "react";
import { Provider, useSelector } from "react-redux";
import { createStore, combineReducers, applyMiddleware, compose } from "redux";
import keplerGlReducer, { enhanceReduxMiddleware, uiStateUpdaters } from "@kepler.gl/reducers";
import { initApplicationConfig } from "@kepler.gl/utils";
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

function KeplerMapInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });

  const isSqlPanelOpen = useSelector((state: any) =>
    state?.keplerGl?.map?.uiState?.mapControls?.sqlPanel?.active
  );

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
