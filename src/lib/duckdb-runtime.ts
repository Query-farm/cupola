type BrowserIdentity = { userAgent: string; platform: string; maxTouchPoints: number };
type RuntimeFeatures = {
  wasmExceptions: boolean;
  wasmSIMD: boolean;
  wasmThreads: boolean;
  crossOriginIsolated: boolean;
};

/** Runtime compatibility only; responsive layouts still depend on viewport width. */
export function isIOSWebKit(browser: BrowserIdentity | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!browser || !/AppleWebKit/i.test(browser.userAgent)) return false;
  return /iPad|iPhone|iPod/i.test(browser.userAgent)
    || (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
}

export function selectDuckDBRuntime(features: RuntimeFeatures): 'coi' | 'eh' {
  if (!features.wasmExceptions) {
    throw new Error("Your browser does not support the features required by Cupola's query engine. Update your browser and try again.");
  }
  return features.wasmSIMD && features.wasmThreads && features.crossOriginIsolated ? 'coi' : 'eh';
}

// This bounds DuckDB's buffer manager, not the browser's entire WASM/JS heap.
export const IOS_QUERY_MEMORY_LIMIT = '256MB';
