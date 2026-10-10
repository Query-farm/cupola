import { expect, test } from 'bun:test';
import { initialCatalog, planConnect, type ConnectSelection } from '../../src/lib/workspace/connect-plan';

const sel = (url: string, catalogName: string, firstCatalog: string | null): ConnectSelection => ({ url, catalogName, firstCatalog });
const catalogs = [{ name: 'sales', specs: [] }, { name: 'hr', specs: [] }];

test('a single-catalog service, or one that could not be listed, keeps the ?service= link', () => {
  expect(planConnect([sel('https://a.example', 'sales', 'sales')])).toEqual({ kind: 'service', selection: sel('https://a.example', 'sales', 'sales') });
  expect(planConnect([sel('https://a.example', '', null)])?.kind).toBe('service');
  // A stored catalog of an unlisted service still opens as before.
  expect(planConnect([sel('https://a.example', 'old', null)])?.kind).toBe('service');
});

test('the first of several catalogs keeps the link; another one, or several, open a workspace', () => {
  expect(planConnect([sel('https://a.example', 'sales', 'sales')])?.kind).toBe('service');
  expect(planConnect([sel('https://a.example', 'hr', 'sales')])?.kind).toBe('workspace');
  const both = planConnect([sel('https://a.example', 'sales', 'sales'), sel('https://a.example', 'hr', 'sales')]);
  expect(both?.kind === 'workspace' && both.selections.map((s) => s.catalogName)).toEqual(['sales', 'hr']);
});

test('the same catalog chosen twice is connected once', () => {
  const plan = planConnect([sel('https://a.example', 'sales', 'sales'), sel('https://A.example/', 'SALES', 'sales')]);
  expect(plan?.kind).toBe('service');
  expect(planConnect([])).toBeNull();
});

test('the first ticked catalog is the stored one when still listed, else the first', () => {
  expect(initialCatalog(catalogs)).toBe('sales');
  expect(initialCatalog(catalogs, 'HR')).toBe('hr');
  expect(initialCatalog(catalogs, 'gone')).toBe('sales');
  expect(initialCatalog([], 'hr')).toBeNull();
});
