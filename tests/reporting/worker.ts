import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ReportClient } from '../../src/lib/reporting/client';

/** A real reference worker with an isolated database. No Yahoo/network dependency in these tests. */
export async function startReportingWorker(displayName = "Finance report library") {
  const directory = await mkdtemp(join(tmpdir(), 'cupola-reporting-'));
  const python = process.env.CUPOLA_REPORTING_PYTHON ?? resolve('../vgi-reporting-protocol-reference/.venv/bin/python');
  const processWorker = spawn(python, ['-m', 'vgi_reporting_reference.worker', '--http', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, REPORTING_DB: join(directory, 'reports.sqlite'), REPORTING_DISPLAY_NAME: displayName, REPORTING_IDENTITIES: JSON.stringify({ bob: { name: "Bob Finance", email: "bob@example.test" } }), REPORTING_TOKENS: JSON.stringify({ 'test-alice': 'alice', 'test-bob': 'bob', 'test-admin': 'operator' }), VGI_INTROSPECT_PRINCIPALS: 'operator', VGI_SIGNING_KEY: 'isolated-reporting-test-key' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => { processWorker.kill(); reject(new Error(`Reporting worker did not start: ${log.slice(-2000)}`)); }, 20_000);
    const output = (chunk: Buffer) => { log += chunk.toString(); const port = /PORT:(\d+)/.exec(log); if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port[1]}`); } };
    processWorker.stdout.on('data', output); processWorker.stderr.on('data', output);
    processWorker.on('error', error => { clearTimeout(timer); reject(new Error(`Set CUPOLA_REPORTING_PYTHON to the reference worker's Python executable: ${error.message}`)); });
    processWorker.on('exit', code => { clearTimeout(timer); reject(new Error(`Reporting worker exited (${code}): ${log.slice(-2000)}`)); });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const ready = await fetch(url + '/health'); if (ready.ok) break; } catch { /* PORT is printed just before the listener starts. */ }
    if (attempt === 99) { processWorker.kill(); throw new Error('Reporting worker did not become healthy.'); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { url, client: (token: string | null = 'test-alice') => new ReportClient(url, { token: async () => token }),
    async stop() { processWorker.kill('SIGTERM'); await new Promise<void>(resolve => { if (processWorker.exitCode != null || processWorker.signalCode != null) resolve(); else processWorker.once('exit', () => resolve()); }); await rm(directory, { recursive: true, force: true }); },
  };
}
