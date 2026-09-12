import { expect, test } from 'vitest';
import { migrateLegacyWorkspaceState } from './legacy-workspace-migration';

test('migrateLegacyWorkspaceState ignores missing, empty, and unsupported legacy state', () => {
  expect(migrateLegacyWorkspaceState(undefined, 'main', 'writer')).toBeUndefined();
  expect(
    migrateLegacyWorkspaceState({ version: 1, nextThreadId: 2, nextCommentId: 2, threads: [] }, 'main', 'writer'),
  ).toBeUndefined();
  expect(
    migrateLegacyWorkspaceState(
      { version: 2, nextThreadId: 2, nextCommentId: 2, threads: [] } as never,
      'main',
      'writer',
    ),
  ).toBeUndefined();
});

test('migrateLegacyWorkspaceState preserves counters and records deterministic migration timestamps', () => {
  const result = migrateLegacyWorkspaceState(
    {
      version: 1,
      nextThreadId: 8,
      nextCommentId: 10,
      threads: [
        {
          id: 7,
          stableId: 'thread-7',
          uri: 'file:///workspace/a.ts',
          startLine: 2,
          endLine: 2,
          status: 'open',
          comments: [],
          updatedAt: 'before-migration',
        },
      ],
    },
    'main',
    'writer',
  );

  expect(result).toMatchObject({ version: 3, writerId: 'writer' });
  expect(result?.branches.main).toMatchObject({ nextThreadId: 8, nextCommentId: 10 });
  expect(result?.branches.main.threads[0].updatedAt).toBe('1970-01-01T00:00:00.000Z');
});
