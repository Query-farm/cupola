import { describe, expect, test } from 'bun:test';
import { directoryKey, folderBranches, type FolderBranch } from '../../src/lib/reporting/file-tree';

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
});
