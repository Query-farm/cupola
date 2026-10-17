import { describe, expect, test } from 'bun:test';
import { isIOSWebKit, selectDuckDBRuntime } from '../../src/lib/duckdb-runtime';

const features = { wasmExceptions: true, wasmSIMD: true, wasmThreads: true, crossOriginIsolated: true };
const safari = 'Mozilla/5.0 AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15';

describe('iOS query engine startup', () => {
  test('iPhone Safari and other iOS browser shells receive the smaller COI worker pool', () => {
    for (const userAgent of [`iPhone ${safari}`, `iPhone ${safari} CriOS/140.0`, `iPad ${safari}`]) {
      expect(isIOSWebKit({ userAgent, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    }
    expect(selectDuckDBRuntime(features)).toBe('coi');
  });

  test('iPad desktop mode uses the same runtime regardless of viewport width', () => {
    expect(isIOSWebKit({ userAgent: `Macintosh ${safari}`, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
  });

  test('desktop Safari and Android keep the threaded runtime when supported', () => {
    for (const browser of [
      { userAgent: `Macintosh ${safari}`, platform: 'MacIntel', maxTouchPoints: 0 },
      { userAgent: 'Android AppleWebKit/537.36 Chrome/140.0', platform: 'Linux aarch64', maxTouchPoints: 5 },
    ]) expect(isIOSWebKit(browser)).toBe(false);
    expect(selectDuckDBRuntime(features)).toBe('coi');
  });

  test('unsupported threaded platforms retain the EH fallback', () => {
    for (const feature of ['wasmSIMD', 'wasmThreads', 'crossOriginIsolated'] as const) {
      expect(selectDuckDBRuntime({ ...features, [feature]: false })).toBe('eh');
    }
  });

  test('a browser without exceptions fails before attempting an incompatible engine', () => {
    expect(() => selectDuckDBRuntime({ ...features, wasmExceptions: false })).toThrow('does not support');
  });
});
