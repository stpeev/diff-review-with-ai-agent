import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ReviewDeletionCommandDeps } from './review-deletion-commands';
import { registerReviewDeletionCommands } from './review-deletion-commands';

interface FakeThread {
  uri: { path: string };
  comments: unknown[];
}

type FakeCommentThread = FakeThread & vscode.CommentThread;

function registeredCommands(commentCount = 1) {
  const handlers = new Map<string, (target: never) => void | Promise<void>>();
  const deleteComment = vi.fn(() => ({ ok: true as const }));
  const deleteThread = vi.fn(() => ({ ok: true as const, drifted: false }));
  const log = vi.fn();
  const refresh = vi.fn();
  const queueSave = vi.fn();
  const thread = {
    uri: { path: 'src/example.ts' },
    comments: Array.from({ length: commentCount }),
  } as FakeCommentThread;
  const reviewService: ReviewDeletionCommandDeps<FakeCommentThread>['reviewService'] = {
    delete: deleteThread,
    deleteComment,
  };

  registerReviewDeletionCommands([], {
    registerCommand: <T>(command: string, handler: (target: T) => void | Promise<void>) => {
      handlers.set(command, handler as (target: never) => void | Promise<void>);
      return { dispose: () => undefined } as never;
    },
    reviewService,
    findThread: () => thread,
    publicId: () => 42,
    relativePath: (uri: vscode.Uri) => uri.path,
    refresh,
    queueSave,
    log,
  });

  return { deleteComment, deleteThread, handlers, log, queueSave, refresh, thread };
}

test('delete note delegates its comment and public thread IDs to the service', () => {
  const { deleteComment, handlers, log } = registeredCommands();
  handlers.get('diffReview.deleteNote')!({ id: 9 } as never);

  expect(deleteComment).toHaveBeenCalledWith(42, 9);
  expect(log).toHaveBeenCalledWith('Comment #9 deleted from thread #42 at src/example.ts');
});

test('delete note reports removal of a thread when its last comment is deleted', () => {
  const { deleteComment, handlers, log } = registeredCommands();
  deleteComment.mockReturnValue({ ok: true, threadDeleted: true } as never);

  handlers.get('diffReview.deleteNote')!({ id: 9 } as never);

  expect(log).toHaveBeenCalledWith('Comment #42 deleted (last comment, thread removed) at src/example.ts');
});

test('delete thread deletes without confirmation and schedules the view update', () => {
  const { deleteThread, handlers, log, queueSave, refresh, thread } = registeredCommands(2);

  handlers.get('diffReview.deleteThread')!(thread as never);

  expect(deleteThread).toHaveBeenCalledWith(42);
  expect(log).toHaveBeenCalledWith('Comment #42 deleted (whole thread, 2 comment(s)) at src/example.ts');
  expect(refresh).toHaveBeenCalledOnce();
  expect(queueSave).toHaveBeenCalledWith(thread.uri);
});
