import { describe, expect, test } from 'vitest';
import { ReviewService } from './service';

interface Thread {
  id: number;
  replies: string[];
  commentIds?: number[];
  drifted?: boolean;
  resolved?: boolean;
  deleted?: boolean;
  fileNote?: boolean;
}

function makeService(threads: Thread[]) {
  let nextCommentId = 1;
  return new ReviewService({
    find: (id) => threads.find((thread) => thread.id === id),
    create: (thread, text) => {
      thread.replies.push(text);
      return { threadId: thread.id };
    },
    appendReply: (thread, text) => {
      thread.replies.push(text);
      return { commentId: nextCommentId++, drifted: !!thread.drifted };
    },
    beginEditing: (thread, commentId) => thread.commentIds?.includes(commentId) ?? false,
    cancelEditing: (thread, commentId) => thread.commentIds?.includes(commentId) ?? false,
    saveEditedComment: (thread, commentId) => thread.commentIds?.includes(commentId) ?? false,
    deleteComment: (_threadId, thread, commentId) => {
      const index = thread.commentIds?.indexOf(commentId) ?? -1;
      if (index < 0) return undefined;
      thread.commentIds!.splice(index, 1);
      return { threadDeleted: thread.commentIds!.length === 0 };
    },
    markDrifted: (thread) => {
      if (thread.drifted) return false;
      thread.drifted = true;
      return true;
    },
    reattach: (thread, line) => {
      if (!thread.drifted) return false;
      thread.drifted = false;
      thread.replies.push(`reattached:${line}`);
      return true;
    },
    keepAsFileNote: (thread) => {
      if (!thread.drifted) return false;
      thread.drifted = false;
      thread.fileNote = true;
      return true;
    },
    resolve: (thread) => ({ drifted: !!thread.drifted }),
    unresolve: (thread) => {
      thread.resolved = false;
    },
    delete: (_threadId, thread) => {
      thread.deleted = true;
      return { drifted: !!thread.drifted };
    },
  });
}

describe('ReviewService.replyFromAgent', () => {
  test('validates thread identity and reply text before mutation', () => {
    const threads: Thread[] = [{ id: 1, replies: [] }];
    const service = makeService(threads);

    expect(service.replyFromAgent(0, 'reply')).toMatchObject({ ok: false, code: 'not-found' });
    expect(service.replyFromAgent(1, '   ')).toMatchObject({ ok: false, code: 'invalid-text' });
    expect(threads[0].replies).toEqual([]);
  });

  test('mutates through its store once and reports drift state', () => {
    const threads: Thread[] = [{ id: 7, replies: [], drifted: true }];
    const result = makeService(threads).replyFromAgent(7, 'Implemented the requested change.');

    expect(result).toEqual({ ok: true, commentId: 1, drifted: true });
    expect(threads[0].replies).toEqual(['Implemented the requested change.']);
  });
});

test('ReviewService validates and creates first comments through its store', () => {
  const thread: Thread = { id: 4, replies: [] };
  const service = makeService([thread]);

  expect(service.create(thread, '  ', 'user')).toEqual({
    ok: false,
    code: 'invalid-text',
    message: 'A review comment must contain text.',
  });
  expect(service.create(thread, 'Please guard this transition.', 'user')).toEqual({ ok: true, threadId: 4 });
  expect(thread.replies).toEqual(['Please guard this transition.']);
});

test('ReviewService routes user replies through the same validated operation', () => {
  const threads: Thread[] = [{ id: 3, replies: [] }];
  const result = makeService(threads).replyFromUser(3, 'Please also cover the error path.');

  expect(result).toEqual({ ok: true, commentId: 1, drifted: false });
  expect(threads[0].replies).toEqual(['Please also cover the error path.']);
});

test('ReviewService.resolve returns the store outcome for a known thread', () => {
  const service = makeService([{ id: 8, replies: [], drifted: true }]);
  expect(service.resolve(8)).toEqual({ ok: true, drifted: true });
  expect(service.resolve(9)).toEqual({ ok: false, code: 'not-found', message: 'Thread #9 not found.' });
});

test('ReviewService routes reopen and delete through its store', () => {
  const thread: Thread = { id: 8, replies: [], resolved: true, drifted: true };
  const service = makeService([thread]);

  expect(service.unresolve(8)).toEqual({ ok: true });
  expect(thread.resolved).toBe(false);
  expect(service.delete(8)).toEqual({ ok: true, drifted: true });
  expect(thread.deleted).toBe(true);
});

test('ReviewService validates comment mutations against their containing thread', () => {
  const thread: Thread = { id: 2, replies: [], commentIds: [12, 13] };
  const service = makeService([thread]);

  expect(service.beginEditing(2, 12)).toEqual({ ok: true });
  expect(service.cancelEditing(2, 12)).toEqual({ ok: true });
  expect(service.saveEditedComment(2, 12)).toEqual({ ok: true });
  expect(service.saveEditedComment(2, 14)).toEqual({
    ok: false,
    code: 'comment-not-found',
    message: 'Comment #14 not found in thread #2.',
  });
  expect(service.deleteComment(2, 12)).toEqual({ ok: true, threadDeleted: false });
  expect(service.deleteComment(2, 13)).toEqual({ ok: true, threadDeleted: true });
  expect(service.deleteComment(2, 13)).toEqual({
    ok: false,
    code: 'comment-not-found',
    message: 'Comment #13 not found in thread #2.',
  });
});

test('ReviewService validates explicit drift-location transitions', () => {
  const thread: Thread = { id: 2, replies: [], drifted: true };
  const service = makeService([thread]);

  expect(service.reattach(2, -1)).toEqual({
    ok: false,
    code: 'invalid-location',
    message: 'A re-attached review location needs a non-negative line.',
  });
  expect(service.reattach(2, 7)).toEqual({ ok: true });
  expect(thread.replies).toEqual(['reattached:7']);
  expect(service.keepAsFileNote(2)).toEqual({
    ok: false,
    code: 'invalid-location',
    message: 'Thread #2 cannot become a file note.',
  });
});

test('ReviewService marks an anchored thread drifted through its store', () => {
  const thread: Thread = { id: 2, replies: [] };
  const service = makeService([thread]);

  expect(service.markDrifted(2)).toEqual({ ok: true });
  expect(thread.drifted).toBe(true);
  expect(service.markDrifted(2)).toEqual({
    ok: false,
    code: 'invalid-location',
    message: 'Thread #2 cannot be marked as drifted.',
  });
});

test('ReviewService converts a drifted thread to a file note through its store', () => {
  const thread: Thread = { id: 3, replies: [], drifted: true };
  const service = makeService([thread]);

  expect(service.keepAsFileNote(3)).toEqual({ ok: true });
  expect(thread.fileNote).toBe(true);
});
