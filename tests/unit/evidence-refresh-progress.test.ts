import { describe, expect, test } from 'bun:test';
import { friendlyTime, stepLabel } from '../../src/components/evidence/EvidenceRefreshProgress';

describe('refresh progress wording', () => {
  test('steps are named for what they prepare, never by their SQL', () => {
    expect(stepLabel({ phase: 'setup', name: 'Dataset SQL · temp.main.daily_orders' })).toBe('Preparing daily orders');
    expect(stepLabel({ phase: 'setup', name: 'Dataset SQL · "order-details"' })).toBe('Preparing order details');
    expect(stepLabel({ phase: 'setup', name: 'Dataset SQL · statement 3' })).toBe('Step 3');
    expect(stepLabel({ phase: 'semantic', name: 'revenue_by_region' })).toBe('Building revenue by region');
    expect(stepLabel({ phase: 'choices', name: 'Country' })).toBe('Options for Country');
  });
  test('times are rounded to what a reader cares about', () => {
    expect(friendlyTime(320)).toBe('under a second');
    expect(friendlyTime(1_980)).toBe('2s');
    expect(friendlyTime(65_400)).toBe('1m 5s');
  });
});
