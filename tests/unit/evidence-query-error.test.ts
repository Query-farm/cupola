import { expect, test } from 'bun:test';
import { queryErrorSummary, queryFailureText, queryFailureTitle, type ReportQueryFailure } from '../../src/lib/evidence/query-error';

test('a long backend error has a short headline and lossless copyable diagnostics', () => {
  const message = `Invalid Input Error: VGI Worker Exception: ValidationError: 21 validation errors for AccountBalanceSnapshot\n${'cash-balance\n  Field required\n'.repeat(21)}`;
  const failure: ReportQueryFailure = {
    phase: 'setup', statementIndex: 4, statementCount: 8, startLine: 12, endLine: 15, name: 'balances',
    sql: 'CREATE TEMP TABLE balances AS\nSELECT * FROM tastytrade.main.balance_snapshots(start_date => $start)',
    executedSql: 'CREATE TEMP TABLE balances AS\nSELECT * FROM tastytrade.main.balance_snapshots(start_date => ?)', message,
  };
  expect(queryFailureTitle(failure)).toBe('Setup SQL failed · statement 4 of 8 · balances · lines 12–15');
  expect(queryErrorSummary(message)).toBe(message.split('\n')[0]);
  const copied = queryFailureText(failure);
  expect(copied).toContain(failure.sql);
  expect(copied).toContain(failure.executedSql!);
  expect(copied).toContain(message);
  expect(queryErrorSummary('x'.repeat(1_000)).length).toBeLessThan(310);
  expect(queryErrorSummary('\n\r\nBinder Error\r\nLINE 2')).toBe('Binder Error');
});
