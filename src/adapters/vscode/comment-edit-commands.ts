import type * as vscode from 'vscode';
import type { ReviewService } from '../../review/service';
import type { ReviewComment } from './review-comment';

type CommentEditingService<Thread> = Pick<
  ReviewService<Thread>,
  'beginEditing' | 'cancelEditing' | 'saveEditedComment'
>;

export interface CommentEditCommandDeps<Thread> {
  registerCommand(command: string, handler: (comment: ReviewComment) => void): vscode.Disposable;
  reviewService: CommentEditingService<Thread>;
  findThread(comment: ReviewComment): Thread | undefined;
  publicId(thread: Thread): number | undefined;
  relativePath(uri: vscode.Uri): string;
  startLine(thread: Thread): number;
  log(message: string): void;
}

/** Register view commands for editing an existing comment through ReviewService. */
export function registerCommentEditCommands<Thread extends vscode.CommentThread>(
  subscriptions: vscode.Disposable[],
  deps: CommentEditCommandDeps<Thread>,
): void {
  subscriptions.push(
    deps.registerCommand('diffReview.editComment', (comment) => {
      const thread = deps.findThread(comment);
      const threadId = thread && deps.publicId(thread);
      if (threadId !== undefined) deps.reviewService.beginEditing(threadId, comment.id);
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.saveEdit', (comment) => {
      const thread = deps.findThread(comment);
      if (!thread) return;
      const threadId = deps.publicId(thread);
      if (threadId === undefined || deps.reviewService.saveEditedComment(threadId, comment.id).ok === false) return;
      deps.log(
        `[Diff Review] Comment #${comment.id} updated (edit saved) at ${deps.relativePath(thread.uri)}:${deps.startLine(thread) + 1}`,
      );
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.cancelEdit', (comment) => {
      const thread = deps.findThread(comment);
      const threadId = thread && deps.publicId(thread);
      if (threadId !== undefined) deps.reviewService.cancelEditing(threadId, comment.id);
    }),
  );
}
