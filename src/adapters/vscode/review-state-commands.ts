import type * as vscode from 'vscode';
import type { ReviewService } from '../../review/service';

type ReviewStateService<Thread> = Pick<ReviewService<Thread>, 'resolve' | 'unresolve'>;

export interface ReviewStateCommandDeps<Thread> {
  registerCommand(command: string, handler: (thread: Thread) => void): vscode.Disposable;
  reviewService: ReviewStateService<Thread>;
  publicId(thread: Thread): number | undefined;
  relativePath(uri: vscode.Uri): string;
  log(message: string): void;
}

/**
 * Register commands whose only review behavior is a state transition. The
 * adapter obtains a public thread handle and presents the result; the service
 * performs the mutation and its associated persistence effects.
 */
export function registerReviewStateCommands<Thread extends vscode.CommentThread>(
  subscriptions: vscode.Disposable[],
  deps: ReviewStateCommandDeps<Thread>,
): void {
  subscriptions.push(
    deps.registerCommand('diffReview.resolve', (thread) => {
      const id = deps.publicId(thread);
      if (id === undefined || deps.reviewService.resolve(id).ok === false) return;
      deps.log(`Comment #${id} updated (resolved) at ${deps.relativePath(thread.uri)}`);
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.unresolve', (thread) => {
      const id = deps.publicId(thread);
      if (id === undefined || deps.reviewService.unresolve(id).ok === false) return;
      deps.log(`Comment #${id} updated (unresolved) at ${deps.relativePath(thread.uri)}`);
    }),
  );
}
