import { describe, expect, test, vi } from 'vitest';
import { watchScopeFile, type ScopeFileWatcher } from './scope-file-watcher';

function setup(overrides: Partial<Parameters<typeof watchScopeFile<string>>[0]> = {}) {
  let changed: (() => void) | undefined;
  let created: (() => void) | undefined;
  const watcher: ScopeFileWatcher = {
    onDidChange(listener) {
      changed = listener;
    },
    onDidCreate(listener) {
      created = listener;
    },
    dispose: vi.fn(),
  };
  const deps = {
    createWatcher: vi.fn(() => watcher),
    filePath: '/storage/comments.json',
    folderPath: '/workspace',
    folderName: 'workspace',
    suppressWatcherUntil: vi.fn(() => undefined),
    now: vi.fn(() => 100),
    read: vi.fn(() => 'valid file'),
    replaceVisibleThreads: vi.fn(),
    refresh: vi.fn(),
    log: vi.fn(),
    showError: vi.fn(),
    ...overrides,
  };
  watchScopeFile(deps);
  return { deps, changed: () => changed!(), created: () => created!() };
}

describe('watchScopeFile', () => {
  test('reloads validated external data for changes and creates', () => {
    const { deps, changed, created } = setup();

    changed();
    created();

    expect(deps.replaceVisibleThreads).toHaveBeenCalledTimes(2);
    expect(deps.replaceVisibleThreads).toHaveBeenLastCalledWith('valid file');
    expect(deps.refresh).toHaveBeenCalledTimes(2);
  });

  test('ignores an unreadable external update and retains the visible view', () => {
    const { deps, changed } = setup({
      read: vi.fn(() => {
        throw new Error('invalid JSON');
      }),
    });

    changed();

    expect(deps.replaceVisibleThreads).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenLastCalledWith(expect.stringContaining('Ignored unreadable external comments update'));
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('Existing comments remain visible'));
  });

  test('does not reload events from the extension own write window', () => {
    const { deps, changed } = setup({ suppressWatcherUntil: vi.fn(() => 101) });

    changed();

    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });
});
