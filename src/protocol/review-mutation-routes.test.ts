import { expect, test } from 'vitest';
import { ReviewService, type ReviewThreadStore } from '../review/service';
import { handleReviewMutationRoute } from './review-mutation-routes';

interface Thread {
  id: number;
  replies: string[];
  resolved: boolean;
}

function createService() {
  const thread: Thread = { id: 4, replies: [], resolved: false };
  const store: ReviewThreadStore<Thread> = {
    find: (id) => (id === thread.id ? thread : undefined),
    create: () => ({ threadId: thread.id }),
    appendReply: (target, text) => {
      target.replies.push(text);
      return { commentId: target.replies.length, drifted: false };
    },
    beginEditing: () => false,
    cancelEditing: () => false,
    saveEditedComment: () => false,
    deleteComment: () => undefined,
    markDrifted: () => false,
    reattach: () => false,
    keepAsFileNote: () => false,
    resolve: (target) => {
      target.resolved = true;
      return { drifted: false };
    },
    unresolve: (target) => {
      target.resolved = false;
    },
    delete: () => ({ drifted: false }),
  };
  return new ReviewService(store);
}

const routeDeps = () => ({
  workspaceMatches: () => true,
  reviewService: createService(),
  threadLocation: () => 'src/file.ts',
});

test('reply route maps the shared service result to the IPC response', () => {
  expect(handleReviewMutationRoute('/reply', JSON.stringify({ threadId: 4, text: 'Done' }), routeDeps())).toMatchObject(
    { status: 200, body: { ok: true, commentId: 1 }, action: 'reply', threadId: 4 },
  );
});

test('mutation routes reject mismatched workspaces before invoking the service', () => {
  const deps = { ...routeDeps(), workspaceMatches: () => false };

  expect(
    handleReviewMutationRoute('/resolve', JSON.stringify({ threadId: 4, expectWorkspaceRoot: '/other' }), deps),
  ).toEqual({
    status: 409,
    body: { error: 'workspace mismatch' },
  });
});

test('missing threads use the service not-found response', () => {
  expect(handleReviewMutationRoute('/delete', JSON.stringify({ threadId: 9 }), routeDeps())).toEqual({
    status: 404,
    body: { error: 'Thread #9 not found.' },
  });
});
