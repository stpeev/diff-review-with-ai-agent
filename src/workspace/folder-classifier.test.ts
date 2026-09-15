import { describe, expect, test, vi } from 'vitest';
import { classifyWorkspaceFolder } from './folder-classifier';

function deps(overrides: Partial<Parameters<typeof classifyWorkspaceFolder<string>>[0]> = {}) {
  let clock = 0;
  return {
    isCurrent: vi.fn(() => true),
    hasDotGit: vi.fn(() => false),
    plainScopeId: vi.fn(() => 'folder:plain'),
    resolveGit: vi.fn(async () => undefined),
    now: vi.fn(() => clock),
    wait: vi.fn(async (milliseconds: number) => {
      clock += milliseconds;
    }),
    pendingTimeoutMs: 1_000,
    pollIntervalMs: 100,
    ...overrides,
  };
}

describe('classifyWorkspaceFolder', () => {
  test('immediately uses a stable plain-folder scope when no Git marker exists', async () => {
    const input = deps();

    await expect(classifyWorkspaceFolder(input)).resolves.toEqual({
      state: 'plain',
      scopeId: 'folder:plain',
      branchKey: '_default',
    });
    expect(input.resolveGit).not.toHaveBeenCalled();
  });

  test('waits for a populated Git scope instead of committing a premature fallback', async () => {
    const input = deps({
      hasDotGit: vi.fn(() => true),
      resolveGit: vi
        .fn<() => Promise<{ scopeId: string; branchKey: string; repository: string } | undefined>>()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ scopeId: 'remote:example', branchKey: 'main', repository: 'repo' }),
    });

    await expect(classifyWorkspaceFolder(input)).resolves.toEqual({
      state: 'git',
      scopeId: 'remote:example',
      branchKey: 'main',
      repository: 'repo',
    });
    expect(input.wait).toHaveBeenCalledWith(100);
  });

  test('degrades a Git-marked folder after the bounded discovery wait', async () => {
    const input = deps({ hasDotGit: vi.fn(() => true), pendingTimeoutMs: 200, pollIntervalMs: 100 });

    await expect(classifyWorkspaceFolder(input)).resolves.toMatchObject({ state: 'plain', scopeId: 'folder:plain' });
    expect(input.resolveGit).toHaveBeenCalledTimes(3);
  });

  test('abandons a stale classification without applying a fallback scope', async () => {
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const input = deps({ hasDotGit: vi.fn(() => true), isCurrent: current });

    await expect(classifyWorkspaceFolder(input)).resolves.toBeUndefined();
  });
});
