import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MOBILE_COI_WORKER, mobileCoiWorker, mobileCoiSourceMap } from '../../scripts/haybarn-mobile-runtime.mjs';

const workerName = 'duckdb-browser-coi.worker.js';
const packageDist = new URL('../../node_modules/@haybarn/haybarn-wasm/dist/', import.meta.url);
const original = readFileSync(new URL(workerName, packageDist), 'utf8');
const originalMap = readFileSync(new URL(`${workerName}.map`, packageDist), 'utf8');

describe('mobile COI loader artifacts', () => {
  test('the installed Haybarn loader changes only one worker-count character and its map URL', () => {
    const mobile = mobileCoiWorker(original);
    const code = mobile.replace(`sourceMappingURL=${MOBILE_COI_WORKER}.map`, `sourceMappingURL=${workerName}.map`);
    expect(code.length).toBe(original.length);
    const changes = [...code].flatMap((character, index) => character === original[index] ? [] : [{ before: original[index], after: character }]);
    expect(changes).toEqual([{ before: '8', after: '4' }]);
  });

  test('source-map positions are preserved and embedded source reflects the smaller pool', () => {
    const before = JSON.parse(originalMap);
    const after = JSON.parse(mobileCoiSourceMap(originalMap));
    expect(after.file).toBe(MOBILE_COI_WORKER);
    expect(after.mappings).toBe(before.mappings);
    expect(after.sources).toEqual(before.sources);
    const changes = after.sourcesContent.filter((source: string, index: number) => source !== before.sourcesContent[index]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('var pthreadPoolSize = 4;');
    expect(changes[0]).not.toContain('var pthreadPoolSize = 8;');
  });

  test('an upstream change or ambiguous initializer requires review instead of silently shipping eight workers', () => {
    expect(() => mobileCoiWorker('new upstream loader')).toThrow('review the mobile runtime');
    expect(() => mobileCoiWorker(original + original)).toThrow('review the mobile runtime');
    expect(() => mobileCoiWorker(mobileCoiWorker(original))).toThrow('review the mobile runtime');
    expect(() => mobileCoiSourceMap(JSON.stringify({ sourcesContent: ['new upstream loader'] }))).toThrow('review the mobile runtime');
  });
});
