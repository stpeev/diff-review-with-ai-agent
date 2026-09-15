import { expect, test } from 'vitest';
import { getFileDiffHunks } from './git-diff';

test('getFileDiffHunks combines staged and unstaged repository diffs for the requested file', async () => {
  const result = await getFileDiffHunks({ fsPath: '/repo/a.ts' }, () => ({
    repositories: [
      {
        rootUri: { fsPath: '/repo' },
        state: { onDidChange: () => undefined },
        diff: async (staged: boolean) => (staged ? '' : 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'),
      },
    ],
  }));

  expect(result).toEqual([{ header: '@@ -1 +1 @@', lines: ['-old', '+new'] }]);
});

test('getFileDiffHunks treats missing Git state and Git failures as no context', async () => {
  await expect(getFileDiffHunks({ fsPath: '/repo/a.ts' }, () => undefined)).resolves.toEqual([]);
  await expect(
    getFileDiffHunks({ fsPath: '/repo/a.ts' }, () => ({
      repositories: [
        {
          rootUri: { fsPath: '/repo' },
          state: { onDidChange: () => undefined },
          diff: () => {
            throw new Error('failed');
          },
        },
      ],
    })),
  ).resolves.toEqual([]);
});
