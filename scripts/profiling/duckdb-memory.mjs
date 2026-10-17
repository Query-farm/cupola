// macOS, Node >= 22.18, Playwright WebKit, and a running Cupola dev server.
// CUPOLA_APP_ORIGIN=http://localhost:4337 node scripts/profiling/duckdb-memory.mjs /tmp/cupola-memory-profile
// Profiles the actual COI payload, each INSTALL/LOAD, and the shared WASM heap.
// This is desktop WebKit. It does not reproduce iPhone Safari's memory budget.
// PROFILE_REPEATS=2 (default); PROFILE_CASES=original-8,candidate-4 selects cases.
// PROFILE_APP_URL=<full local catalog URL> profiles the real app instead of the
// minimal engine harness. It uses the app's current runtime configuration.
// PROFILE_EXCLUDE_EXTENSIONS=spatial,iceberg,ducklake omits those extensions.
// Full-app exclusions use the existing development-only test selection hook.
// Keep other WebKit launches and dev-server dependency changes paused during a run.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { webkit, devices } from '@playwright/test';
import { tableFromIPC } from '@query-farm/apache-arrow';
import { SHELL_EXTENSIONS, TEST_EXTENSIONS_KEY, extensionInstallSql, shellExtensionsForRuntime } from '../../src/lib/duckdb-engine.ts';
import { mobileCoiWorker } from '../haybarn-mobile-runtime.mjs';

if (process.platform !== 'darwin') throw new Error('Physical footprint sampling requires macOS.');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const origin = process.env.CUPOLA_APP_ORIGIN || 'http://localhost:4337';
const base = `${origin}/v${pkg.version}/`;
const excludedExtensions = (process.env.PROFILE_EXCLUDE_EXTENSIONS || '').split(',').map(name => name.trim()).filter(Boolean);
for (const name of excludedExtensions) {
  const extension = SHELL_EXTENSIONS.find(extension => extension.name === name);
  if (!extension || extension.required) throw new Error(`Cannot exclude unknown or required extension: ${name}`);
}
// Full-app runs use the iPhone profile and its production startup policy.
// The minimal harness can still measure the original all-extension setup.
const availableExtensions = process.env.PROFILE_APP_URL ? shellExtensionsForRuntime(SHELL_EXTENSIONS, true) : SHELL_EXTENSIONS;
const extensions = availableExtensions.filter(extension => !excludedExtensions.includes(extension.name));
// A real HTTP document is necessary: WebKit does not enable isolation for a
// Playwright-synthesized navigation response, even with COOP/COEP headers.
const documentName = `cupola-memory-profile-${process.pid}.html`;
const documentPath = new URL(`../../public/${documentName}`, import.meta.url);
writeFileSync(documentPath, '<!doctype html><meta charset="utf-8"><title>Cupola COI memory profile</title>');
process.on('exit', () => rmSync(documentPath, { force: true }));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
const output = resolve(process.argv[2] || `/tmp/cupola-memory-${Date.now()}`);
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(`${tmpdir()}/cupola-memory-`);
process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
const samplerExecutable = `${temp}/process-memory`;
execFileSync('xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-o', samplerExecutable,
  fileURLToPath(new URL('./process-memory.c', import.meta.url))]);
const originalWorker = readFileSync(new URL('../../node_modules/@haybarn/haybarn-wasm/dist/duckdb-browser-coi.worker.js', import.meta.url), 'utf8');

const configs = process.env.PROFILE_APP_URL ? [{ name: 'full-app', appUrl: process.env.PROFILE_APP_URL }] : [
  { name: 'original-8', pool: 8 },
  { name: 'pool-only-4', pool: 4 },
  { name: 'bounded-8', pool: 8, maximumThreads: 1, memoryLimit: '256MB' },
  { name: 'candidate-4', pool: 4, maximumThreads: 1, memoryLimit: '256MB' },
  { name: 'thread-only-8', pool: 8, maximumThreads: 1 },
  { name: 'thread-only-4', pool: 4, maximumThreads: 1 },
];
const selected = process.env.PROFILE_CASES?.split(',');
const repeats = Number(process.env.PROFILE_REPEATS || 2);
if (!Number.isInteger(repeats) || repeats < 1) throw new Error('PROFILE_REPEATS must be a positive integer.');
if (selected?.some(name => !configs.some(config => config.name === name))) throw new Error('Unknown PROFILE_CASES selection.');
const webContentPids = () => new Set(execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
  .split('\n').filter(line => line.includes('/ms-playwright/') && line.includes('WebContent'))
  .map(line => Number(line.trim().split(/\s+/)[0])));
const mib = value => Math.round(value / 1048576 * 10) / 10;
const results = [];

for (let repeat = 0; repeat < repeats; repeat++) {
  // Reverse the order on alternate repeats to limit order/cache bias.
  for (const config of (repeat % 2 ? [...configs].reverse() : configs).filter(c => !selected || selected.includes(c.name))) {
    const beforePids = webContentPids();
    const browser = await webkit.launch();
    let sampler;
    const samples = [];
    const stages = [];
    let phase = 'blank';
    const run = { config, repeat, browserVersion: browser.version(), excludedExtensions, requestedExtensions: extensions.map(extension => extension.name), stages, samples, requests: [] };
    const save = () => writeFileSync(`${output}/${config.name}-${repeat + 1}.json`, JSON.stringify(run, null, 2));
    try {
      const page = await browser.newPage({ ...devices['iPhone 13'] });
      page.setDefaultTimeout(60_000);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.includes('/haybarn/') || url.hostname === 'haybarn-extensions.query.farm') {
          run.requests.push({ time: Date.now(), url: url.origin + url.pathname });
        }
      });
      page.on('pageerror', error => console.error(config.name, error.message));
      page.on('crash', () => { run.crashed = true; save(); });
      let releaseScripts;
      if (config.appUrl) {
        if (excludedExtensions.length) {
          await page.addInitScript(({ key, names }) => localStorage.setItem(key, names.join(',')), {
            key: TEST_EXTENSIONS_KEY, names: run.requestedExtensions,
          });
        }
        const scriptsAllowed = new Promise(resolve => { releaseScripts = resolve; });
        await page.route('**/*', async route => {
          if (route.request().resourceType() === 'script') await scriptsAllowed;
          await route.continue();
        });
        await page.exposeFunction('__profilePhase', name => { phase = name; });
        await page.addInitScript(() => {
          let previous;
          setInterval(() => {
            const name = window.__bridge?.bootPhase || (window.__bridge?.runQuery ? 'ready' : 'app JavaScript');
            if (name !== previous) { previous = name; window.__profilePhase(name); }
          }, 25);
        });
      } else {
        await page.route('**/haybarn/duckdb-browser-coi.worker.js', route => route.fulfill({
          contentType: 'application/javascript', body: config.pool === 4 ? mobileCoiWorker(originalWorker) : originalWorker,
        }));
      }
      await page.goto(config.appUrl || `${base}${documentName}`, { waitUntil: 'commit' });
      await delay(200);
      const newPids = [...webContentPids()].filter(pid => !beforePids.has(pid));
      if (newPids.length !== 1) throw new Error(`Cannot uniquely identify this browser's WebContent PID: ${newPids}. Run without concurrent WebKit launches.`);
      run.pid = newPids[0];
      sampler = spawn(samplerExecutable, [String(run.pid)], { stdio: ['ignore', 'pipe', 'inherit'] });
      createInterface({ input: sampler.stdout }).on('line', line => samples.push({ phase, ...JSON.parse(line) }));
      await delay(500);
      if (!samples.length) throw new Error('No physical memory samples; check process accounting permissions.');
      if (config.appUrl) {
        releaseScripts();
        await page.waitForFunction(() => typeof window.__bridge?.runQuery === 'function', null, { timeout: 90_000 });
        await page.evaluate(() => window.__bridge.attached);
        await delay(3000);
        run.queryOk = await page.evaluate(async () => (await window.__bridge.query('SELECT 42')).ok);
        run.isolated = await page.evaluate(() => crossOriginIsolated);
        if (!run.queryOk || !run.isolated) throw new Error('Full app failed its isolated query check.');
        run.catalogs = await page.evaluate(() => window.__bridge.catalogStatuses().map(({ alias, state }) => ({ alias, state })));
        if (new URL(config.appUrl).searchParams.has('service') && !run.catalogs.some(catalog => catalog.state === 'attached')) {
          throw new Error('Full app did not attach the requested catalog.');
        }
        const loadedBytes = await page.evaluate(async () => {
          const result = await window.__bridge.query('SELECT extension_name FROM duckdb_extensions() WHERE loaded');
          if (!result.ok || !result.arrowBuffers?.length) throw new Error('Could not verify loaded extensions.');
          return Array.from(new Uint8Array(result.arrowBuffers[0]));
        });
        run.loaded = [...tableFromIPC(Uint8Array.from(loadedBytes)).getChildAt(0)];
        for (const name of new Set(samples.map(s => s.phase))) {
          const observed = samples.filter(s => s.phase === name);
          stages.push({ name, start: observed[0].time, endFootprint: observed.at(-1).footprint,
            peakFootprint: Math.max(...observed.map(s => s.footprint)), lifetimePeak: observed.at(-1).lifetimePeak });
        }
        // Cross-check the sampler against Apple's own footprint tool while the
        // process is still alive. Keep the original output, including warnings.
        try { writeFileSync(`${output}/footprint-${repeat + 1}.txt`, execFileSync('footprint', ['-p', String(run.pid)], { encoding: 'utf8', timeout: 15_000 })); }
        catch (error) { run.footprintToolError = String(error); }
      } else {
        const stage = async (name, action, inspect = false) => {
          phase = name;
          const start = Date.now();
          const firstSample = samples.length;
          await action();
          const operationEnd = Date.now();
          const engine = inspect ? await page.evaluate(async () => {
            const id = window.profileConnection.useUnsafe((_db, id) => id);
            const handle = await window.profileDb.getInterruptHandle(id);
            const memory = await window.profileConnection.query('SELECT coalesce(sum(memory_usage_bytes), 0)::DOUBLE AS bytes FROM duckdb_memory()');
            return { wasmHeapBytes: handle?.memory.byteLength, duckdbTrackedBytes: Number(memory.getChildAt(0).get(0)) };
          }) : undefined;
          // Give the external 100ms sampler one observation after the operation.
          await delay(120);
          const observed = samples.slice(firstSample);
          stages.push({ name, start, operationEnd, durationMs: operationEnd - start, engine,
            endFootprint: samples.at(-1)?.footprint,
            peakFootprint: Math.max(...observed.map(s => s.footprint)),
            lifetimePeak: samples.at(-1)?.lifetimePeak });
          console.log(config.name, repeat + 1, name, `${mib(stages.at(-1).endFootprint)} MiB`, engine ? `WASM ${mib(engine.wasmHeapBytes)} MiB / DuckDB tracked ${mib(engine.duckdbTrackedBytes)} MiB` : '');
          save();
        };
        await stage('JS client import', () => page.evaluate(async origin => {
          window.profileDuckDB = await import(`${origin}/node_modules/.vite/deps/@haybarn_haybarn-wasm.js`);
        }, origin));
        await stage('COI instantiate', () => page.evaluate(async base => {
          if (!crossOriginIsolated) throw new Error('Harness must be cross-origin isolated.');
          const duckdb = window.profileDuckDB;
          const worker = new Worker(`${base}haybarn/duckdb-browser-coi.worker.js`);
          window.profileDb = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
          await window.profileDb.instantiate(`${base}haybarn/duckdb-coi.wasm`, `${base}haybarn/duckdb-browser-coi.pthread.worker.js`);
        }, base));
        await stage('database open', () => page.evaluate(async config => {
          await window.profileDb.open({ arrowLosslessConversion: true, ...(config.maximumThreads ? { maximumThreads: config.maximumThreads } : {}) });
          window.profileConnection = await window.profileDb.connect();
          if (config.memoryLimit) await window.profileConnection.query(`SET memory_limit = '${config.memoryLimit}'`);
          await window.profileConnection.query('SET autoload_known_extensions = false; SET autoinstall_known_extensions = false');
        }, config), true);
        for (const extension of extensions) {
          await stage(`INSTALL ${extension.name}`, () => page.evaluate(sql => window.profileConnection.query(sql).then(() => {}), extensionInstallSql(extension)), true);
          await stage(`LOAD ${extension.name}`, () => page.evaluate(sql => window.profileConnection.query(sql).then(() => {}), `LOAD ${extension.name}`), true);
        }
        await stage('ready, idle 3s', () => delay(3000), true);
        run.loaded = await page.evaluate(async () => {
          const t = await window.profileConnection.query('SELECT extension_name FROM duckdb_extensions() WHERE loaded');
          return [...t.getChildAt(0)];
        });
      }
      if (run.requestedExtensions.some(name => !run.loaded.includes(name)) || excludedExtensions.some(name => run.loaded.includes(name))) {
        throw new Error(`Loaded extensions do not match requested selection: ${run.loaded.join(',')}`);
      }
      if (excludedExtensions.some(name => run.requests.some(request => new URL(request.url).pathname.endsWith(`/${name}.duckdb_extension.wasm`)))) {
        throw new Error('An excluded extension was fetched during startup.');
      }
      run.peakFootprint = Math.max(...samples.map(s => s.footprint));
      run.lifetimePeak = Math.max(...samples.map(s => s.lifetimePeak));
      results.push({ config, repeat, browserVersion: run.browserVersion, excludedExtensions, loaded: run.loaded, peakMiB: mib(run.peakFootprint), lifetimePeakMiB: mib(run.lifetimePeak), stages });
      console.log(config.name, repeat + 1, 'PEAK', mib(run.peakFootprint), 'MiB; kernel lifetime peak', mib(run.lifetimePeak), 'MiB');
    } catch (error) {
      run.error = String(error);
      throw error;
    } finally {
      sampler?.kill();
      save();
      await browser.close();
    }
  }
}
writeFileSync(`${output}/summary.json`, JSON.stringify({ packageVersion: pkg.version, engine: pkg.dependencies['@haybarn/haybarn-wasm'], nodeVersion: process.version, arch: process.arch, platform: execFileSync('sw_vers', { encoding: 'utf8' }).trim(), mode: process.env.PROFILE_APP_URL ? 'full app with 25ms boot phase observations and 100ms OS footprint samples; desktop Playwright WebKit; fresh browser per run' : 'minimal engine harness; desktop Playwright WebKit; 100ms physical footprint samples; stage checkpoints pause 120ms; no forced GC; fresh browser per run; no queries or catalog attach beyond memory instrumentation', results }, null, 2));
console.log(`Profile written to ${output}`);
