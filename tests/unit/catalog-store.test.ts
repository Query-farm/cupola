import { expect, test, spyOn } from 'bun:test';
import { catalogInventory, catalogsForTool, observeCatalogQuery } from '../../src/lib/catalog-store';

test('discovery awaits current catalogs; a metadata outage does not block other tools', async () => {
  const snapshot = spyOn(catalogInventory, 'getSnapshot').mockReturnValue({ catalogs: [], ready: true, refreshing: false, error: 'offline', revision: 1 });
  const current = spyOn(catalogInventory, 'current').mockRejectedValue(new Error('Catalog discovery failed'));
  try {
    await expect(catalogsForTool('list_catalogs')).rejects.toThrow('Catalog discovery failed');
    for (const name of ['run_sql', 'read_query_results', 'get_report', 'propose_report_edit'])
      expect(await catalogsForTool(name)).toEqual([]);
    expect(current).toHaveBeenCalledTimes(1);
  } finally { snapshot.mockRestore(); current.mockRestore(); }
});

test('a partially failed SQL batch still invalidates the inventory', async () => {
  const invalidate = spyOn(catalogInventory, 'invalidate').mockImplementation(() => {});
  try {
    await expect(observeCatalogQuery("ATTACH ':memory:' AS local; SELECT * FROM missing", async () => { throw new Error('missing table'); })).rejects.toThrow('missing table');
    expect(invalidate).toHaveBeenCalledTimes(1);
    await observeCatalogQuery("SELECT 'ATTACH x'", async () => ({ ok: true }));
    expect(invalidate).toHaveBeenCalledTimes(1);
  } finally { invalidate.mockRestore(); }
});
