import * as vscode from 'vscode';

/** Return a thread's actionable editor range or fail with a stable adapter error. */
export function requireThreadRange(thread: vscode.CommentThread): vscode.Range {
  if (!thread.range) {
    throw new Error('This review thread no longer has an editor location.');
  }
  return thread.range;
}
