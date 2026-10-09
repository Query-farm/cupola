import { afterEach, expect, test } from 'bun:test';
import { engine, type EngineConnection } from '../../src/lib/shell-bridge';
import { NotebookSession } from '../../src/lib/notebooks/session';

const original = { openConnection: engine.openConnection, lifecycleStatus: engine.lifecycleStatus, defaultCatalog: engine.defaultCatalog };
afterEach(() => Object.assign(engine, original));
function fixture() {
  engine.lifecycleStatus = 'ready';
  engine.defaultCatalog = { alias: null, schema: null, requested: null, fellBack: false };
  let closes = 0;
  const connection: EngineConnection = {
    query: async () => ({ ok: true }),
    queryPrepared: async () => ({ ok: true }),
    transaction: async work => work(async () => ({ ok: true })),
    close: async () => { closes++; },
  };
  return { connection, closes: () => closes };
}

test('one notebook opens one lazy connection and closes it exactly once', async () => {
  const { connection, closes } = fixture();
  let opens = 0;
  engine.openConnection = async () => { opens++; return connection; };
  const session = new NotebookSession();
  expect(opens).toBe(0);
  await Promise.all([session.query('SELECT 1'), session.query('SELECT 2')]);
  expect(opens).toBe(1);
  await Promise.all([session.close(), session.close()]);
  expect(closes()).toBe(1);
  await expect(session.query('SELECT 3')).rejects.toThrow('closed');
});

test('closing while a connection is opening closes the eventual handle', async () => {
  const { connection, closes } = fixture();
  let finish!: (connection: EngineConnection) => void;
  let started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  engine.openConnection = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const session = new NotebookSession();
  const query = session.query('SELECT 1');
  await opening;
  const closed = session.close();
  await expect(query).rejects.toThrow('closed');
  finish(connection);
  await closed;
  expect(closes()).toBe(1);
});

test('cancelling the readiness wait is prompt and leaves the notebook session usable', async () => {
  const { connection, closes } = fixture();
  let finish!: (connection: EngineConnection) => void;
  engine.openConnection = () => new Promise(resolve => { finish = resolve; });
  const session = new NotebookSession();
  const controller = new AbortController();
  const query = session.query('SELECT 1', [], { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('Stopped'));
  await expect(query).rejects.toThrow('Stopped');
  finish(connection);
  expect((await session.query('SELECT 2')).ok).toBe(true);
  await session.close();
  expect(closes()).toBe(1);
});
