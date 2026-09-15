import type * as vscode from 'vscode';

export interface DriftedLocationCommandDeps<Thread> {
  registerCommand(command: string, handler: (thread: Thread) => void): vscode.Disposable;
  publicId(thread: Thread): number | undefined;
  isDrifted(thread: Thread): boolean;
  showActions(threadId: number): void;
}

/** Register the command that opens corrective actions for a drifted comment view. */
export function registerDriftedLocationCommand<Thread extends vscode.CommentThread>(
  subscriptions: vscode.Disposable[],
  deps: DriftedLocationCommandDeps<Thread>,
): void {
  subscriptions.push(
    deps.registerCommand('diffReview.fixDriftedLocation', (thread) => {
      const id = deps.publicId(thread);
      if (id !== undefined && deps.isDrifted(thread)) deps.showActions(id);
    }),
  );
}
