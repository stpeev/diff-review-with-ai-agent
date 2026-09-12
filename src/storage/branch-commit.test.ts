import { expect, test } from 'vitest';
import { emptyScopeFile } from '../comment-store';
import { commitBranchState } from './branch-commit';

function scope(revision: number) {
  return {
    ...emptyScopeFile('writer-a'),
    revision,
    branches: {
      main: {
        nextThreadId: 2,
        nextCommentId: 2,
        threads: [
          {
            id: 1,
            stableId: 'thread-1',
            uri: 'file:///workspace/a.ts',
            startLine: 0,
            endLine: 0,
            status: 'open' as const,
            comments: [
              {
                id: 1,
                stableId: 'comment-1',
                role: 'user' as const,
                body: 'Old',
                timestamp: '2026-09-12T00:00:00.000Z',
              },
            ],
            updatedAt: '2026-09-12T00:00:00.000Z',
          },
        ],
      },
      other: { nextThreadId: 1, nextCommentId: 1, threads: [] },
    },
  };
}

test('matching revision directly replaces the saved branch so a deletion is not resurrected', () => {
  const onDisk = scope(4);
  const result = commitBranchState({
    onDisk,
    lastKnownFile: onDisk,
    lastLoadedRevision: 4,
    branchKey: 'main',
    branch: {
      nextThreadId: 2,
      nextCommentId: 2,
      threads: [],
      deletedThreads: [{ id: 1, deletedAt: '2026-09-12T01:00:00.000Z' }],
    },
    writerId: 'writer-b',
  });

  expect(result).toMatchObject({ revision: 5, writerId: 'writer-b' });
  expect(result.branches.main!.threads).toEqual([]);
  expect(result.branches.other).toEqual(onDisk.branches.other);
});

test('changed revision merges a racing branch update instead of replacing the scope', () => {
  const lastKnown = scope(4);
  const onDisk = {
    ...scope(5),
    branches: {
      ...scope(5).branches,
      feature: { nextThreadId: 3, nextCommentId: 1, threads: [] },
    },
  };
  const result = commitBranchState({
    onDisk,
    lastKnownFile: lastKnown,
    lastLoadedRevision: 4,
    branchKey: 'main',
    branch: { nextThreadId: 2, nextCommentId: 2, threads: [] },
    writerId: 'writer-b',
  });

  expect(result.revision).toBe(6);
  expect(result.branches.feature).toMatchObject(onDisk.branches.feature);
});
