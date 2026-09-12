import { expect, test, vi } from 'vitest';
import { emptyScopeFile } from '../comment-store';
import { writeScopeMeta } from './scope-meta';

test('writes comment totals as advisory scope metadata', () => {
  const file = emptyScopeFile('writer');
  file.branches.main = {
    nextThreadId: 2,
    nextCommentId: 1,
    threads: [
      {
        id: 1,
        uri: 'file:///a',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const writeAtomic = vi.fn();
  writeScopeMeta(
    { scopeId: 'scope', folderPath: '/workspace/project', scopeDirectory: '/storage/scope', file },
    { writeAtomic },
    new Date('2026-09-14T00:00:00.000Z'),
  );
  expect(writeAtomic).toHaveBeenCalledWith('/storage/scope/meta.json', expect.stringContaining('"commentCount":1'));
});
