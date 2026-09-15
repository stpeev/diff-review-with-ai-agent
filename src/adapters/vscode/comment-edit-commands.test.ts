import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ReviewComment } from './review-comment';
import type { CommentEditCommandDeps } from './comment-edit-commands';
import { registerCommentEditCommands } from './comment-edit-commands';

interface FakeThread {
  uri: { path: string };
}

type FakeCommentThread = FakeThread & vscode.CommentThread;

function registeredCommands() {
  const handlers = new Map<string, (comment: ReviewComment) => void>();
  const beginEditing = vi.fn(() => ({ ok: true as const }));
  const cancelEditing = vi.fn(() => ({ ok: true as const }));
  const saveEditedComment = vi.fn(() => ({ ok: true as const }));
  const log = vi.fn();
  const thread = { uri: { path: 'src/example.ts' } } as FakeCommentThread;
  const reviewService: CommentEditCommandDeps<FakeCommentThread>['reviewService'] = {
    beginEditing,
    cancelEditing,
    saveEditedComment,
  };

  registerCommentEditCommands([], {
    registerCommand: (command: string, handler: (comment: ReviewComment) => void) => {
      handlers.set(command, handler);
      return { dispose: () => undefined } as never;
    },
    reviewService,
    findThread: () => thread,
    publicId: () => 42,
    relativePath: (uri: vscode.Uri) => uri.path,
    startLine: () => 6,
    log,
  });

  return { beginEditing, cancelEditing, handlers, log, saveEditedComment };
}

test('edit commands delegate to the review service using the thread public handle', () => {
  const { beginEditing, cancelEditing, handlers } = registeredCommands();
  const comment = { id: 9 } as ReviewComment;

  handlers.get('diffReview.editComment')!(comment);
  handlers.get('diffReview.cancelEdit')!(comment);

  expect(beginEditing).toHaveBeenCalledWith(42, 9);
  expect(cancelEditing).toHaveBeenCalledWith(42, 9);
});

test('save edit logs only after the service accepts the mutation', () => {
  const { handlers, log, saveEditedComment } = registeredCommands();
  const comment = { id: 9 } as ReviewComment;

  handlers.get('diffReview.saveEdit')!(comment);

  expect(saveEditedComment).toHaveBeenCalledWith(42, 9);
  expect(log).toHaveBeenCalledWith('Comment #9 updated (edit saved) at src/example.ts:7');
});

test('edit commands ignore comments no longer associated with a thread', () => {
  const { handlers, beginEditing, cancelEditing, saveEditedComment } = registeredCommands();
  const comment = { id: 9 } as ReviewComment;

  registerCommentEditCommands([], {
    registerCommand: (command: string, handler: (comment: ReviewComment) => void) => {
      handlers.set(command, handler);
      return { dispose: () => undefined } as never;
    },
    reviewService: { beginEditing, cancelEditing, saveEditedComment },
    findThread: () => undefined,
    publicId: () => 42,
    relativePath: (uri: vscode.Uri) => uri.path,
    startLine: () => 6,
    log: vi.fn(),
  });
  handlers.get('diffReview.editComment')!(comment);
  handlers.get('diffReview.saveEdit')!(comment);
  handlers.get('diffReview.cancelEdit')!(comment);

  expect(beginEditing).not.toHaveBeenCalled();
  expect(saveEditedComment).not.toHaveBeenCalled();
  expect(cancelEditing).not.toHaveBeenCalled();
});
