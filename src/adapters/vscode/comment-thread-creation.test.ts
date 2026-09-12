import { expect, test } from 'vitest';
import { ReviewService } from '../../review/service';
import { createCommentThreadAt } from './comment-thread-creation';

interface FakeThread {
  disposed: boolean;
}

function makeDeps(fileText = 'first\nsecond\nthird') {
  const created: Array<{ thread: FakeThread; text: string }> = [];
  const reviewService = new ReviewService<FakeThread>({
    find: () => undefined,
    create: (thread, text) => {
      created.push({ thread, text });
      return { threadId: created.length };
    },
    appendReply: () => ({ commentId: 1, drifted: false }),
    beginEditing: () => false,
    cancelEditing: () => false,
    saveEditedComment: () => false,
    deleteComment: () => undefined,
    markDrifted: () => false,
    reattach: () => false,
    keepAsFileNote: () => false,
    resolve: () => ({ drifted: false }),
    unresolve: () => undefined,
    delete: () => ({ drifted: false }),
  });
  const threads: FakeThread[] = [];
  return {
    created,
    threads,
    deps: {
      fileExists: (filePath: string) => filePath === '/workspace/file.ts',
      readTextFile: () => fileText,
      displayPath: () => 'file.ts',
      createRange: (startLine: number, endLine: number) => ({ startLine, endLine }),
      createThread: () => {
        const thread = { disposed: false };
        threads.push(thread);
        return thread;
      },
      disposeThread: (thread: FakeThread) => {
        thread.disposed = true;
      },
      reviewService,
    },
  };
}

test('createCommentThreadAt validates a file range and delegates creation to the service', () => {
  const { deps, created } = makeDeps();
  expect(createCommentThreadAt(deps, { scheme: 'file', fsPath: '/workspace/file.ts' }, 1, 2, 'Review this')).toEqual({
    threadId: 1,
  });
  expect(created).toHaveLength(1);
  expect(created[0]?.text).toBe('Review this');
});

test('createCommentThreadAt rejects missing files and invalid ranges before creating a thread', () => {
  const { deps, threads } = makeDeps();
  expect(createCommentThreadAt(deps, { scheme: 'file', fsPath: '/missing.ts' }, 0, 0, 'Review this')).toEqual({
    error: 'File not found: /missing.ts',
  });
  expect(createCommentThreadAt(deps, { scheme: 'file', fsPath: '/workspace/file.ts' }, 2, 3, 'Review this')).toEqual({
    error: 'Line out of range for file.ts (file has 3 line(s)).',
  });
  expect(threads).toEqual([]);
});

test('createCommentThreadAt disposes a constructed thread when the service rejects its text', () => {
  const { deps, threads } = makeDeps();
  expect(createCommentThreadAt(deps, { scheme: 'file', fsPath: '/workspace/file.ts' }, 0, 0, '  ')).toEqual({
    error: 'A review comment must contain text.',
  });
  expect(threads[0]?.disposed).toBe(true);
});
