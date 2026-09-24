import type { AsyncDuckDB } from '@haybarn/haybarn-wasm';

/** Consume the pending API as Arrow IPC without going through a second Arrow library. */
export async function pendingQuery(db: AsyncDuckDB, connection: number, sql: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  let header = await db.startPendingQuery(connection, sql, false);
  while (header === null) {
    if (signal.aborted) {
      await db.cancelPendingQuery(connection);
      signal.throwIfAborted();
    }
    header = await db.pollPendingQuery(connection);
  }
  const chunks = [header];
  let length = header.byteLength;
  while (true) {
    signal.throwIfAborted();
    const chunk = await db.fetchQueryResults(connection);
    if (chunk === null) continue;
    if (!chunk.byteLength) break;
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Replace positional tokens, never question marks inside strings/comments.
 * DuckDB tokenizer offsets are UTF-8 byte offsets. Values remain engine-bound
 * in private session variables, which getvariable folds to typed constants. */
export function parameterVariableSql(sql: string, tokens: { offsets: number[]; types: number[] }, names: string[]): string {
  const bytes = new TextEncoder().encode(sql);
  const decoder = new TextDecoder();
  let result = '', start = 0, index = 0;
  for (let i = 0; i < tokens.offsets.length; i++) {
    const offset = tokens.offsets[i];
    if (tokens.types[i] !== 3 || bytes[offset] !== 63) continue;
    if (bytes[offset + 1] >= 48 && bytes[offset + 1] <= 57) throw new Error('Cancellable queries require unnumbered positional parameters.');
    if (index >= names.length) throw new Error('Query parameter count mismatch.');
    result += decoder.decode(bytes.subarray(start, offset)) + `getvariable('${names[index++]}')`;
    start = offset + 1;
  }
  if (index !== names.length) throw new Error('Query parameter count mismatch.');
  return result + decoder.decode(bytes.subarray(start));
}
