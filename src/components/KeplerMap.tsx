/**
 * Kepler.gl map component with isolated Redux store.
 * Uses our DuckDB-WASM worker via VgiDuckDBAdapter so queries
 * can be run against VGI tables and rendered as map layers.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { Provider, useDispatch } from "react-redux";
import { createStore, combineReducers, applyMiddleware, compose } from "redux";
import keplerGlReducer, { enhanceReduxMiddleware, uiStateUpdaters } from "@kepler.gl/reducers";
import { addDataToMap } from "@kepler.gl/actions";
import { initApplicationConfig } from "@kepler.gl/utils";
import { VgiDuckDBAdapter } from "@/lib/vgi-duckdb-adapter";
import { Play } from "lucide-react";

let KeplerGl: any = null;
let arrowSchemaToFields: any = null;
let keplerStore: any = null;
let configInitialized = false;
let queryCounter = 0;

function getStore() {
  if (keplerStore) return keplerStore;
  const { DEFAULT_MAP_CONTROLS } = uiStateUpdaters;
  const reducer = combineReducers({
    keplerGl: keplerGlReducer.initialState({
      uiState: {
        currentModal: null,
        mapControls: DEFAULT_MAP_CONTROLS,
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

/** Simple SQL bar that runs queries via our DuckDB worker and adds results to the map. */
function SqlBar() {
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const dispatch = useDispatch();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const runQuery = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || running) return;

    const queryFn = (window as any).__duckdbQuery;
    if (!queryFn) {
      setStatus("DuckDB not connected. Open SQL Shell first.");
      return;
    }

    setRunning(true);
    setStatus("Running...");

    try {
      const result = await queryFn(trimmed);
      if (!result.ok) {
        setStatus(`Error: ${result.error}`);
        return;
      }
      if (!result.arrowBuffers?.length) {
        setStatus("OK (no results)");
        return;
      }

      const { tableFromIPC } = await import("apache-arrow");
      const table = tableFromIPC(result.arrowBuffers[0]);

      // Convert Arrow schema to kepler fields if available
      let fields: any[] | undefined;
      if (arrowSchemaToFields) {
        try {
          // Get DuckDB column types for proper geometry handling
          const adapter = new VgiDuckDBAdapter();
          const conn = await adapter.connect();
          fields = arrowSchemaToFields(table);
        } catch {}
      }

      queryCounter++;
      const label = trimmed.length > 40 ? trimmed.slice(0, 37) + "..." : trimmed;

      dispatch(
        addDataToMap({
          datasets: [
            {
              info: {
                id: `query_${queryCounter}`,
                label,
              },
              data: {
                fields: fields || table.schema.fields.map((f: any) => ({
                  name: f.name,
                  type: "string",
                  format: "",
                  analyzerType: "STRING",
                })),
                rows: table,
              },
            },
          ],
          options: {
            centerMap: true,
          },
        })
      );

      setStatus(`Added ${table.numRows} rows as layer`);
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setRunning(false);
    }
  }, [sql, running, dispatch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  };

  return (
    <div className="flex flex-col gap-1 px-3 py-2 bg-[#242730] border-t border-[#3a3d47] relative z-50">
      <div className="flex items-start gap-2">
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="SELECT * FROM environment.parks LIMIT 500;"
          rows={2}
          className="flex-1 bg-[#1a1c24] text-[#e0e0e0] text-sm font-mono px-3 py-2 rounded border border-[#3a3d47] focus:border-[#6ba034] focus:outline-none resize-none placeholder:text-[#666]"
        />
        <button
          onClick={runQuery}
          disabled={running || !sql.trim()}
          className="px-3 py-2 bg-[#6ba034] hover:bg-[#4a7c23] disabled:bg-[#3a3d47] text-white text-sm font-semibold rounded transition-colors flex items-center gap-1.5"
          title="Run query (Ctrl+Enter)"
        >
          <Play className="h-3.5 w-3.5" />
          Run
        </button>
      </div>
      {status && (
        <div className={`text-xs font-mono ${status.startsWith("Error") ? "text-red-400" : "text-[#8a8a8a]"}`}>
          {status}
        </div>
      )}
    </div>
  );
}

function KeplerMapInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });

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

  // SQL bar takes ~80px, rest is map
  const sqlBarHeight = 80;
  const mapHeight = Math.max(100, dims.height - sqlBarHeight);

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
      <SqlBar />
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

        // Try to get arrowSchemaToFields for proper field mapping
        try {
          arrowSchemaToFields = (duckdbModule as any).arrowSchemaToFields;
        } catch {}

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
