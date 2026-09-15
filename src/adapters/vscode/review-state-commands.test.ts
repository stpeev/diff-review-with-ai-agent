import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ReviewStateCommandDeps } from './review-state-commands';
import { registerReviewStateCommands } from './review-state-commands';

interface FakeThread {
  uri: { path: string };
}

type FakeCommentThread = FakeThread & vscode.CommentThread;

function registeredCommands(publicId: (thread: FakeCommentThread) => number | undefined = () => 42) {
  const handlers = new Map<string, (thread: FakeCommentThread) => void>();
  const resolve = vi.fn(() => ({ ok: true as const, drifted: false }));
  const unresolve = vi.fn(() => ({ ok: true as const }));
  const log = vi.fn();
  const subscriptions: vscode.Disposable[] = [];
  const reviewService: ReviewStateCommandDeps<FakeCommentThread>['reviewService'] = { resolve, unresolve };

  registerReviewStateCommands(subscriptions, {
    registerCommand: (command: string, handler: (thread: FakeCommentThread) => void) => {
      handlers.set(command, handler);
      return { dispose: () => undefined } as never;
    },
    reviewService,
    publicId,
    relativePath: (uri: vscode.Uri) => uri.path,
    log,
  });

  return { handlers, log, resolve, unresolve, subscriptions };
}

test('resolve command delegates a known public thread handle to the review service', () => {
  const { handlers, log, resolve, subscriptions } = registeredCommands();
  const thread = { uri: { path: 'src/example.ts' } };

  handlers.get('diffReview.resolve')!(thread as FakeCommentThread);

  expect(resolve).toHaveBeenCalledWith(42);
  expect(log).toHaveBeenCalledWith('Comment #42 updated (resolved) at src/example.ts');
  expect(subscriptions).toHaveLength(2);
});

test('unresolve command delegates a known public thread handle to the review service', () => {
  const { handlers, log, unresolve } = registeredCommands();
  const thread = { uri: { path: 'src/example.ts' } };

  handlers.get('diffReview.unresolve')!(thread as FakeCommentThread);

  expect(unresolve).toHaveBeenCalledWith(42);
  expect(log).toHaveBeenCalledWith('Comment #42 updated (unresolved) at src/example.ts');
});

test('state commands ignore a view with no public thread handle', () => {
  const { handlers, log, resolve, unresolve } = registeredCommands(() => undefined);
  const thread = { uri: { path: 'src/example.ts' } };

  handlers.get('diffReview.resolve')!(thread as FakeCommentThread);
  handlers.get('diffReview.unresolve')!(thread as FakeCommentThread);

  expect(resolve).not.toHaveBeenCalled();
  expect(unresolve).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});
