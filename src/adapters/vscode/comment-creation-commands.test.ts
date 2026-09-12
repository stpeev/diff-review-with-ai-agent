import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { CommentCreationCommandDeps } from './comment-creation-commands';
import { registerCommentCreationCommands } from './comment-creation-commands';

interface FakeThread {
  uri: { path: string };
}

type FakeCommentThread = FakeThread & vscode.CommentThread;

function registeredCommands(publicId: (thread: FakeCommentThread) => number | undefined = () => 42) {
  const handlers = new Map<string, (reply: vscode.CommentReply) => void>();
  const create = vi.fn(() => ({ ok: true as const, threadId: 99 }));
  const replyFromUser = vi.fn(() => ({ ok: true as const, commentId: 7, drifted: false }));
  const log = vi.fn();
  const reviewService: CommentCreationCommandDeps<FakeCommentThread>['reviewService'] = { create, replyFromUser };

  registerCommentCreationCommands([], {
    registerCommand: <T>(command: string, handler: (argument: T) => void) => {
      handlers.set(command, handler as (reply: vscode.CommentReply) => void);
      return { dispose: () => undefined } as never;
    },
    reviewService,
    publicId,
    relativePath: (uri: vscode.Uri) => uri.path,
    startLine: () => 6,
    log,
  });

  return { create, handlers, log, replyFromUser };
}

test('create command delegates a new user comment to the review service', () => {
  const { create, handlers, log } = registeredCommands();
  const thread = { uri: { path: 'src/example.ts' } } as FakeCommentThread;

  handlers.get('diffReview.createNote')!({ thread, text: 'Please simplify this.' } as vscode.CommentReply);

  expect(create).toHaveBeenCalledWith(thread, 'Please simplify this.', 'user');
  expect(log).toHaveBeenCalledWith('[Diff Review] Comment #99 created at src/example.ts:7');
});

test('reply command delegates using the public thread handle', () => {
  const { handlers, log, replyFromUser } = registeredCommands();
  const thread = { uri: { path: 'src/example.ts' } } as FakeCommentThread;

  handlers.get('diffReview.reply')!({ thread, text: 'Addressed.' } as vscode.CommentReply);

  expect(replyFromUser).toHaveBeenCalledWith(42, 'Addressed.');
  expect(log).toHaveBeenCalledWith('[Diff Review] Comment #42 updated (reply added) at src/example.ts:7');
});

test('reply command ignores a thread without a public handle', () => {
  const { handlers, replyFromUser } = registeredCommands(() => undefined);
  const thread = { uri: { path: 'src/example.ts' } } as FakeCommentThread;

  handlers.get('diffReview.reply')!({ thread, text: 'Addressed.' } as vscode.CommentReply);

  expect(replyFromUser).not.toHaveBeenCalled();
});
