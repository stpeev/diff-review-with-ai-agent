import * as vscode from 'vscode';
import { type ReviewThreadMetadata } from '../../review/model';
import { presentationFor } from '../../review/presentation';

/** Render plain review metadata onto a VS Code comment thread. */
export function presentReviewThread(
  thread: vscode.CommentThread,
  metadata: ReviewThreadMetadata,
  status = metadata.status,
): void {
  metadata.status = status;
  const presentation = presentationFor({ status, location: metadata.location });
  thread.label = presentation.label;
  thread.contextValue = presentation.contextValue;
  thread.state = presentation.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
  thread.collapsibleState = presentation.collapsed
    ? vscode.CommentThreadCollapsibleState.Collapsed
    : vscode.CommentThreadCollapsibleState.Expanded;
}
