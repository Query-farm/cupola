import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MOBILE_COI_WORKER = 'duckdb-browser-coi-mobile.worker.js';
const originalWorker = 'duckdb-browser-coi.worker.js';
const poolInitializer = /initMainThread\(\)\{for\(var ([a-zA-Z_$][\w$]*)=8;\1--;\)PThread\.allocateUnusedWorker\(\);/g;

/** Keep the exact COI WASM and pthread implementation, but prewarm four workers
 * instead of eight on iOS. Instantiation opens a default four-thread database
 * before db.open can apply maximumThreads: 1; a smaller pool can deadlock while
 * synchronously waiting for newly spawned pthreads. A one-character replacement preserves source-map
 * positions. Fail closed if a Haybarn upgrade changes its generated loader. */
export function mobileCoiWorker(source) {
  const matches = [...source.matchAll(poolInitializer)];
  if (matches.length !== 1) throw new Error('Haybarn COI worker-pool initializer changed; review the mobile runtime before publishing.');
  return source.replace(poolInitializer, match => match.replace('=8;', '=4;'))
    .replace(`sourceMappingURL=${originalWorker}.map`, `sourceMappingURL=${MOBILE_COI_WORKER}.map`);
}

export function mobileCoiSourceMap(source) {
  const map = JSON.parse(source);
  let replacements = 0;
  map.file = MOBILE_COI_WORKER;
  map.sourcesContent = map.sourcesContent.map(content => content?.replace(/var pthreadPoolSize = 8;/g, match => {
    replacements++;
    return match.replace('= 8;', '= 4;');
  }));
  if (replacements !== 1) throw new Error('Haybarn COI source-map pool initializer changed; review the mobile runtime before publishing.');
  return JSON.stringify(map);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: haybarn-mobile-runtime.mjs <Haybarn dist> <output directory>');
  // Validate both artifacts before writing either one.
  const worker = mobileCoiWorker(readFileSync(resolve(input, originalWorker), 'utf8'));
  const map = mobileCoiSourceMap(readFileSync(resolve(input, `${originalWorker}.map`), 'utf8'));
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, MOBILE_COI_WORKER), worker);
  writeFileSync(resolve(output, `${MOBILE_COI_WORKER}.map`), map);
}
