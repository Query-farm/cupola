import { expect, test } from 'bun:test';
import { parameterVariableSql } from '../../src/lib/pending-query';

test('parameter references preserve quoted question marks, comments and UTF-8 offsets', () => {
  const sql = `SELECT 'é?', ?, $$?$$, "?" /* ? */ -- ?\n, ?`;
  const bytes = new TextEncoder().encode(sql);
  const offsets = Array.from(bytes, (byte, index) => byte === 63 ? index : -1).filter(index => index >= 0);
  // Only standalone parameters are operator tokens in DuckDB's tokenizer.
  const types = [2, 3, 2, 0, 5, 5, 3];
  expect(parameterVariableSql(sql, { offsets, types }, ['p0', 'p1'])).toBe(
    `SELECT 'é?', getvariable('p0'), $$?$$, "?" /* ? */ -- ?\n, getvariable('p1')`,
  );
});

test('parameter count and unsupported numbered parameters fail before execution', () => {
  expect(() => parameterVariableSql('SELECT ?', { offsets: [7], types: [3] }, [])).toThrow('count mismatch');
  expect(() => parameterVariableSql('SELECT 1', { offsets: [], types: [] }, ['p0'])).toThrow('count mismatch');
  expect(() => parameterVariableSql('SELECT ?1', { offsets: [7], types: [3] }, ['p0'])).toThrow('unnumbered');
});
