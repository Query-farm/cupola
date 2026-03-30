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
import { VgiDuckDBAdapter, VgiDuckDBConnection } from "@/lib/vgi-duckdb-adapter";
import { Play } from "lucide-react";

let KeplerGl: any = null;
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
      // Use the same pipeline as @kepler.gl/duckdb's SqlPanel:
      // 1. Create temp table from query
      // 2. Get DuckDB column types
      // 3. Cast GEOMETRY→WKB, BIGINT→DOUBLE
      // 4. Set GeoArrow metadata
      // 5. Dispatch to addDataToMap with format: 'arrow'

      const conn = new VgiDuckDBConnection();
      const duckdbUtils = await import("@kepler.gl/duckdb");
      const { arrowSchemaToFields: schemaToFields } = await import("@kepler.gl/processors");

      const tempTable = "memory.main.temp_keplergl_table";

      // 1) Create temp table in the in-memory default database (VGI catalog is read-only)
      await conn.query(`CREATE OR REPLACE TABLE ${tempTable} AS ${trimmed}`);

      // 2) Get DuckDB types
      const duckDbColumns = await duckdbUtils.getDuckDBColumnTypes(conn, tempTable);
      const tableDuckDBTypes = duckdbUtils.getDuckDBColumnTypesMap(duckDbColumns);

      // 3) Cast types for kepler (GEOMETRY → WKB, BIGINT → DOUBLE)
      const castQuery = duckdbUtils.castDuckDBTypesForKepler(tempTable, duckDbColumns);
      const arrowTable = await conn.query(castQuery);

      // 4) Set GeoArrow extension metadata
      duckdbUtils.setGeoArrowWKBExtension(arrowTable, duckDbColumns);

      // 5) Drop temp table
      await conn.query(`DROP TABLE ${tempTable};`);

      // Convert to kepler fields
      const keplerFields = schemaToFields(arrowTable, tableDuckDBTypes);

      queryCounter++;
      const label = trimmed.length > 40 ? trimmed.slice(0, 37) + "..." : trimmed;

      dispatch(
        addDataToMap({
          datasets: [
            {
              info: {
                id: `query_${queryCounter}`,
                label,
                format: "arrow",
              },
              data: {
                fields: keplerFields,
                rows: arrowTable as any,
              },
            },
          ],
          options: {
            centerMap: true,
          },
        })
      );

      setStatus(`Added ${arrowTable.numRows} rows as layer`);
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
