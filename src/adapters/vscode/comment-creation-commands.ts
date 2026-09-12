import type * as vscode from 'vscode';
import type { ReviewService } from '../../review/service';

type CommentCreationService<Thread> = Pick<ReviewService<Thread>, 'create' | 'replyFromUser'>;

export interface CommentCreationCommandDeps<Thread> {
  registerCommand<T>(command: string, handler: (argument: T) => void): vscode.Disposable;
  reviewService: CommentCreationService<Thread>;
  publicId(thread: Thread): number | undefined;
  relativePath(uri: vscode.Uri): string;
  startLine(thread: Thread): number;
  log(message: string): void;
}

/** Register commands that create a root review comment or a user reply. */
export function registerCommentCreationCommands<Thread extends vscode.CommentThread>(
  subscriptions: vscode.Disposable[],
  deps: CommentCreationCommandDeps<Thread>,
): void {
  subscriptions.push(
    deps.registerCommand('diffReview.createNote', (reply: vscode.CommentReply) => {
      const thread = reply.thread as Thread;
      const created = deps.reviewService.create(thread, reply.text, 'user');
      if (created.ok === false) return;
      deps.log(
        `[Diff Review] Comment #${created.threadId} created at ${deps.relativePath(thread.uri)}:${deps.startLine(thread) + 1}`,
      );
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.reply', (reply: vscode.CommentReply) => {
      const thread = reply.thread as Thread;
      const threadId = deps.publicId(thread);
      if (threadId === undefined || deps.reviewService.replyFromUser(threadId, reply.text).ok === false) return;
      deps.log(
        `[Diff Review] Comment #${threadId} updated (reply added) at ${deps.relativePath(thread.uri)}:${deps.startLine(thread) + 1}`,
      );
    }),
  );
}
