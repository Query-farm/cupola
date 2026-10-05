import { describe, expect, mock, test } from 'bun:test';
import { buildPaletteCommands, filterCommands, fuzzyScore, groupCommands, isMacPlatform, isPaletteShortcut, type PaletteContext } from '../../src/lib/command-palette';

function context(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    workspaces: [
      { id: 'w1', label: 'Finance', current: true, catalogCount: 2 },
      { id: 'w2', label: 'Marketing', current: false, catalogCount: 1 },
      { id: 'w3', label: 'sales, crm', current: false, catalogCount: 2 },
    ],
    catalogs: [
      { id: 'c1', alias: 'sales', host: 'a.example', state: 'attached', enabled: true, isDefault: true },
      { id: 'c2', alias: 'crm', host: 'crm.example', state: 'sign-in-required', enabled: true, isDefault: false },
      { id: 'c3', alias: 'ops', host: 'ops.example', state: 'failed', enabled: true, isDefault: false },
      { id: 'c4', alias: 'hr', host: 'hr.example', state: 'attached', enabled: true, isDefault: false },
      { id: 'c5', alias: 'old', host: 'old.example', state: 'disabled', enabled: false, isDefault: false },
    ],
    reports: [{ id: 'r1', title: 'Quarterly revenue' }, { id: 'r2', title: 'Churn' }],
    actions: {
      switchWorkspace: mock(), attachCatalog: mock(), signIn: mock(), retry: mock(), makeDefault: mock(),
      manageWorkspaces: mock(), openReport: mock(), shareWorkspaceLink: mock(async () => 'copied'),
    },
    ...overrides,
  };
}

describe('buildPaletteCommands', () => {
  test('per-catalog commands follow each catalog\'s status', () => {
    const titles = buildPaletteCommands(context()).map(c => c.title);
    expect(titles).toEqual([
      'Sign in to crm', 'Retry crm', 'Retry ops', 'Make hr default', 'Attach catalog…',
      'Switch workspace…', 'Manage workspaces', 'Share workspace link', 'Open report…',
    ]);
  });
  test('Switch workspace lists the other workspaces; Open report lists All reports and each report', () => {
    const commands = buildPaletteCommands(context());
    expect(commands.find(c => c.id === 'switch')!.children!.map(c => c.title)).toEqual(['Marketing', 'sales, crm']);
    expect(commands.find(c => c.id === 'reports')!.children!.map(c => c.title)).toEqual(['All reports', 'Quarterly revenue', 'Churn']);
  });
  test('commands run their actions', async () => {
    const ctx = context();
    const commands = buildPaletteCommands(ctx);
    commands.find(c => c.title === 'Sign in to crm')!.run!();
    expect(ctx.actions.signIn).toHaveBeenCalledWith('c2');
    commands.find(c => c.title === 'Make hr default')!.run!();
    expect(ctx.actions.makeDefault).toHaveBeenCalledWith('c4');
    commands.find(c => c.id === 'switch')!.children![0].run!();
    expect(ctx.actions.switchWorkspace).toHaveBeenCalledWith('w2');
    commands.find(c => c.id === 'reports')!.children![0].run!();
    expect(ctx.actions.openReport).toHaveBeenCalledWith();
    commands.find(c => c.id === 'reports')!.children![2].run!();
    expect(ctx.actions.openReport).toHaveBeenCalledWith('r2');
    expect(await commands.find(c => c.id === 'share')!.run!()).toBe('copied');
  });
  test('rename commands only when the app offers renaming', () => {
    const renameCatalog = mock();
    const ctx = context();
    const commands = buildPaletteCommands({ ...ctx, actions: { ...ctx.actions, renameCatalog } });
    expect(commands.filter(c => c.id.startsWith('rename:')).map(c => c.title)).toContain('Rename catalog sales…');
    commands.find(c => c.id === 'rename:c1')!.run!();
    expect(renameCatalog).toHaveBeenCalledWith('c1');
  });
});

describe('filtering', () => {
  test('fuzzyScore: in-order subsequence, substrings and word starts rank higher', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('xyz', 'Attach catalog')).toBeNull();
    expect(fuzzyScore('atc', 'Attach catalog')).not.toBeNull();
    expect(fuzzyScore('tca', 'Attach catalog')).not.toBeNull();
    expect(fuzzyScore('attach', 'Attach catalog')!).toBeGreaterThan(fuzzyScore('atcg', 'Attach catalog')!);
    expect(fuzzyScore('cat', 'Attach catalog')!).toBeGreaterThan(fuzzyScore('cat', 'Make category')! - 1000);
  });
  test('no query keeps the order', () => {
    const commands = buildPaletteCommands(context());
    expect(filterCommands(commands, '  ')).toEqual(commands);
  });
  test('ranks the best match first and drops non-matches', () => {
    const titles = filterCommands(buildPaletteCommands(context()), 'retry').map(c => c.title);
    expect(titles.slice(0, 2)).toEqual(['Retry crm', 'Retry ops']);
    expect(titles).not.toContain('Manage workspaces');
  });
  test('matches keywords and hosts', () => {
    expect(filterCommands(buildPaletteCommands(context()), 'login').map(c => c.title)[0]).toBe('Sign in to crm');
    expect(filterCommands(buildPaletteCommands(context()), 'ops.example').map(c => c.title)[0]).toBe('Retry ops');
  });
  test('root searches page children, titled with where they are from', () => {
    const found = filterCommands(buildPaletteCommands(context()), 'marketing');
    expect(found[0]).toMatchObject({ id: 'switch/w2', title: 'Switch workspace: Marketing' });
    expect(filterCommands(buildPaletteCommands(context()), 'churn')[0].title).toBe('Open report: Churn');
  });
  test('a page searches only its own children', () => {
    const page = buildPaletteCommands(context()).find(c => c.id === 'reports')!;
    const found = filterCommands(page.children!, 'rev', false).map(c => c.title);
    expect(found[0]).toBe('Quarterly revenue');
    expect(found).not.toContain('Churn');
    expect(found.some(title => title.startsWith('Switch'))).toBe(false);
  });
  test('groups keep first-seen order', () => {
    expect(groupCommands(buildPaletteCommands(context())).map(g => g.group)).toEqual(['Catalogs', 'Workspaces', 'Reports']);
  });
});

describe('shortcut', () => {
  const key = (overrides: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides });
  test('⌘K on macOS, Ctrl+K elsewhere', () => {
    expect(isPaletteShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ key: 'K', metaKey: true }), true)).toBe(true);
  });
  test('not with Shift (CodeMirror deletes a line) or Alt, and not in the terminal (it clears)', () => {
    expect(isPaletteShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ metaKey: true }), true, true)).toBe(false);
    expect(isPaletteShortcut(key({ key: 'j', metaKey: true }), true)).toBe(false);
  });
  test('isMacPlatform', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32', userAgent: 'Windows NT' })).toBe(false);
    expect(isMacPlatform({})).toBe(false);
  });
});
