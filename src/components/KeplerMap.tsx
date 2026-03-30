/**
 * Kepler.gl map component with isolated Redux store.
 * Uses our DuckDB-WASM worker via VgiDuckDBAdapter so kepler.gl's
 * SQL panel can query all VGI catalog tables.
 */
import { useEffect, useRef, useState } from "react";
import { Provider, useSelector } from "react-redux";
import { createStore, combineReducers, applyMiddleware, compose } from "redux";
import keplerGlReducer, { enhanceReduxMiddleware, uiStateUpdaters } from "@kepler.gl/reducers";
import { initApplicationConfig, getApplicationConfig } from "@kepler.gl/utils";
import { VgiDuckDBAdapter } from "@/lib/vgi-duckdb-adapter";

// Module-level singletons (persist across remounts)
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

/** Inner component that has access to the Redux store via useSelector. */
function KeplerMapInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });

  const isSqlPanelOpen = useSelector((state: any) =>
    state?.keplerGl?.map?.uiState?.mapControls?.sqlPanel?.active
  );

  // Measure container
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setDims({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const mapHeight = isSqlPanelOpen ? Math.floor(dims.height * 0.6) : dims.height;
  const sqlHeight = isSqlPanelOpen ? dims.height - mapHeight : 0;

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col">
      <div style={{ height: mapHeight, width: dims.width }}>
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
        // Configure Monaco editor to use local bundle instead of CDN
        // (CDN AMD loader conflicts with Vite's ESM environment)
        const [monacoLoader, monaco] = await Promise.all([
          import("@monaco-editor/react").then(m => m.loader),
          import("monaco-editor"),
        ]);
        monacoLoader.config({ monaco });

        const [keplerComponents, duckdbModule] = await Promise.all([
          import("@kepler.gl/components"),
          import("@kepler.gl/duckdb"),
        ]);

        KeplerGl = keplerComponents.default || keplerComponents.KeplerGl;

        // Get SqlPanel from duckdb components subpath
        try {
          const duckdbComponents = await import("@kepler.gl/duckdb/components");
          SqlPanel = duckdbComponents.SqlPanel;
        } catch {
          SqlPanel = (duckdbModule as any).SqlPanel;
        }

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
