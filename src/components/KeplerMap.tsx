/**
 * Kepler.gl map component with isolated Redux store.
 * Uses our DuckDB-WASM worker via VgiDuckDBAdapter so kepler.gl's
 * SQL panel can query all VGI catalog tables.
 */
import { useEffect, useRef, useState } from "react";
import { Provider } from "react-redux";
import { createStore, combineReducers, applyMiddleware, compose } from "redux";
import keplerGlReducer, { enhanceReduxMiddleware, uiStateUpdaters } from "@kepler.gl/reducers";
import { initApplicationConfig } from "@kepler.gl/utils";
import { VgiDuckDBAdapter } from "@/lib/vgi-duckdb-adapter";

// Module-level singletons (persist across remounts)
let KeplerGl: any = null;
let keplerStore: any = null;
let configInitialized = false;

function getStore() {
  if (keplerStore) return keplerStore;

  const { DEFAULT_MAP_CONTROLS } = uiStateUpdaters;
  const reducer = combineReducers({
    keplerGl: keplerGlReducer.initialState({
      uiState: {
        mapControls: {
          ...DEFAULT_MAP_CONTROLS,
          sqlPanel: {
            active: false,
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

export function KeplerMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [ready, setReady] = useState(!!KeplerGl);
  const [error, setError] = useState<string | null>(null);

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

  // Load kepler.gl modules
  useEffect(() => {
    if (KeplerGl) return;

    (async () => {
      try {
        const [keplerComponents, duckdbModule] = await Promise.all([
          import("@kepler.gl/components"),
          import("@kepler.gl/duckdb"),
        ]);

        KeplerGl = keplerComponents.default || keplerComponents.KeplerGl;

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

  return (
    <div ref={containerRef} className="w-full h-full">
      {error && (
        <div className="flex items-center justify-center h-full text-red-400 text-sm bg-white">
          {error}
        </div>
      )}
      {!error && !ready && (
        <div className="flex items-center justify-center h-full text-gray-500 text-sm bg-white">
          Loading Kepler.gl...
        </div>
      )}
      {ready && KeplerGl && (
        <Provider store={getStore()}>
          <KeplerGl
            id="map"
            width={dims.width}
            height={dims.height}
            mapboxApiAccessToken=""
          />
        </Provider>
      )}
    </div>
  );
}
