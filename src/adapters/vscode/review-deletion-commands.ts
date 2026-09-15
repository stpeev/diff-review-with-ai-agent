import type * as vscode from 'vscode';
import type { ReviewService } from '../../review/service';
import type { ReviewComment } from './review-comment';

type ReviewDeletionService<Thread> = Pick<ReviewService<Thread>, 'delete' | 'deleteComment'>;

export interface ReviewDeletionCommandDeps<Thread> {
  registerCommand<T>(command: string, handler: (target: T) => void | Promise<void>): vscode.Disposable;
  reviewService: ReviewDeletionService<Thread>;
  findThread(comment: ReviewComment): Thread | undefined;
  publicId(thread: Thread): number | undefined;
  relativePath(uri: vscode.Uri): string;
  confirmThreadDeletion(commentCount: number): Promise<boolean>;
  refresh(): void;
  queueSave(uri: vscode.Uri): void;
  log(message: string): void;
}

/**
 * Register deletion commands. Confirmation and messages belong to the VS Code
 * boundary; ReviewService owns the deletion mutation and its view effects.
 */
export function registerReviewDeletionCommands<Thread extends vscode.CommentThread>(
  subscriptions: vscode.Disposable[],
  deps: ReviewDeletionCommandDeps<Thread>,
): void {
  subscriptions.push(
    deps.registerCommand('diffReview.deleteNote', (comment: ReviewComment) => {
      const thread = deps.findThread(comment);
      if (!thread) return;
      const threadId = deps.publicId(thread);
      if (threadId === undefined) return;
      const result = deps.reviewService.deleteComment(threadId, comment.id);
      if (result.ok === false) return;
      const path = deps.relativePath(thread.uri);
      if (result.threadDeleted) {
        deps.log(`[Diff Review] Comment #${threadId} deleted (last comment, thread removed) at ${path}`);
      } else {
        deps.log(`[Diff Review] Comment #${comment.id} deleted from thread #${threadId} at ${path}`);
      }
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.deleteThread', async (thread: Thread) => {
      const commentCount = thread.comments.length;
      if (commentCount > 1 && !(await deps.confirmThreadDeletion(commentCount))) return;
      const threadId = deps.publicId(thread);
      if (threadId === undefined || deps.reviewService.delete(threadId).ok === false) return;
      deps.log(
        `[Diff Review] Comment #${threadId} deleted (whole thread, ${commentCount} comment(s)) at ${deps.relativePath(thread.uri)}`,
      );
      deps.refresh();
      deps.queueSave(thread.uri);
    }),
  );
}
