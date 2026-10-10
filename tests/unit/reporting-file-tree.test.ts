import { describe, expect, test } from 'bun:test';
import { directoryKey, folderBranches, reportDirectoryNodes, type FolderBranch } from '../../src/lib/reporting/file-tree';
import { currentReportNode, reportNavigationHref, reportNodeKey } from '../../src/lib/reporting/navigation';

describe('report folder tree', () => {
  test('keeps visible folders reachable when their parent is hidden', () => {
    const tree = folderBranches('worker', [{ id: 'child', name: 'Team reports', parentId: 'hidden', writable: true }]);
    expect(tree).toHaveLength(1);
    expect(tree[0].folderId).toBe('child');
    expect(tree[0].writable).toBe(true);
  });
  test('cycles cannot hide folders or recurse forever', () => {
    const tree = folderBranches('worker', [
      { id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'c' },
    ]);
    const ids = (nodes: FolderBranch[]): string[] => nodes.flatMap(n => [n.folderId, ...ids(n.children)]);
    expect(ids(tree).sort()).toEqual(['a', 'b', 'c']);
  });
  test('folder identity is scoped to its storage location, including root', () => {
    expect(directoryKey('worker-a', 'same')).not.toBe(directoryKey('worker-b', 'same'));
    expect(directoryKey('worker-a')).not.toBe(directoryKey('worker-a', 'null'));
  });
  test('nests reports beneath visible folders and keeps reports with hidden parents reachable', () => {
    const tree = reportDirectoryNodes('https://reports.test', [{ id: 'team', name: 'Team', parentId: null }, { id: 'quarter', name: 'Quarter', parentId: 'team' }], [
      { id: 'nested', name: 'Revenue', folderId: 'quarter' }, { id: 'orphan', name: 'Shared report', folderId: 'hidden' },
    ]);
    expect(tree[0].children?.[0].children?.[0].destination).toEqual({ location: 'https://reports.test', folderId: 'quarter', reportId: 'nested' });
    expect(tree[1].destination.reportId).toBe('orphan');
    expect(tree[0].children?.[0].children?.[0].id).toBe(currentReportNode('?report_service=https://reports.test&report_id=nested'));
    expect(tree[1].id).not.toBe(reportNodeKey({ location: 'local', reportId: 'orphan' }));
  });
  test('sidebar links retain the workspace and folder, without carrying credentials or another revision', () => {
    const href = reportNavigationHref('https://finance.test', { location: 'https://reports.test', folderId: 'Q / 1', reportId: 'annual' }, 'https://cupola.test/reports?local_ws=workspace&report_revision=old&p.region=east#token=secret');
    const query = new URL(href, 'https://cupola.test').searchParams;
    expect(Object.fromEntries(query)).toEqual({ local_ws: 'workspace', report_service: 'https://reports.test', report_id: 'annual', report_folder: 'Q / 1' });
    expect(href).not.toContain('secret');
    expect(currentReportNode('?report_service=local&evidence_report=annual')).toBe(reportNodeKey({ location: 'local', reportId: 'annual' }));
  });
});
