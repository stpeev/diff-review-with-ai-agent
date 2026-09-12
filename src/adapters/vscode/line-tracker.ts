import * as vscode from 'vscode';
import { findAnchorLine } from '../../review/anchors';
import type { ReviewLocation } from '../../review/model';

export interface LineTrackingMetadata {
  location: ReviewLocation;
  anchorHash?: string;
}

export interface LineTrackerDeps {
  liveThreads(): Iterable<vscode.CommentThread>;
  isTracked(thread: vscode.CommentThread): boolean;
  metadata(thread: vscode.CommentThread): LineTrackingMetadata | undefined;
  markDrifted(thread: vscode.CommentThread): void;
  scheduleSave(thread: vscode.CommentThread): void;
}

/**
 * Keep anchored review views aligned with edits to their document. The review
 * service owns the drift transition; this adapter only translates VS Code
 * document/range objects into its view effects.
 */
export function applyLineTrackingChange(
  event: vscode.TextDocumentChangeEvent,
  deps: LineTrackerDeps,
  anchorContextRadius: number,
  anchorSearchRadius: number,
): void {
  if (event.contentChanges.length === 0) return;

  const documentUri = event.document.uri.toString();
  // A drifted range is only the last location where the anchor was seen. It
  // must never be shifted as though it were still an actionable line.
  const affected = [...deps.liveThreads()].filter(
    (thread) => thread.uri.toString() === documentUri && deps.metadata(thread)?.location.kind !== 'drifted',
  );
  if (affected.length === 0) return;

  // Process bottom-up so an edit below a thread cannot alter the line used to
  // assess a later edit above it.
  const changes = [...event.contentChanges].sort((left, right) => right.range.start.line - left.range.start.line);
  const needsReverify = new Set<vscode.CommentThread>();

  for (const change of changes) {
    const startLine = change.range.start.line;
    const oldEndLine = change.range.end.line;
    const newLines = change.text.replace(/\r\n/g, '\n').split('\n').length - 1;
    const delta = newLines - (oldEndLine - startLine);
    if (delta === 0) continue;

    for (const thread of affected) {
      const range = thread.range;
      if (!range) continue;
      if (range.start.line > oldEndLine) {
        const start = range.start.line + delta;
        const end = range.end.line + delta;
        if (start >= 0) thread.range = new vscode.Range(start, 0, end, 0);
      } else if (range.start.line >= startLine && range.start.line <= oldEndLine && delta < 0) {
        needsReverify.add(thread);
      }
    }
  }

  if (needsReverify.size > 0) {
    const lines = event.document.getText().split(/\r\n|\n/);
    for (const thread of needsReverify) {
      const metadata = deps.metadata(thread);
      const range = thread.range;
      if (!metadata?.anchorHash || metadata.location.kind !== 'anchored' || !range) continue;
      const found = findAnchorLine(
        lines,
        metadata.anchorHash,
        range.start.line,
        anchorContextRadius,
        anchorSearchRadius,
      );
      if (found === undefined) deps.markDrifted(thread);
      else thread.range = new vscode.Range(found, 0, found, 0);
    }
  }

  for (const thread of affected) {
    if (deps.isTracked(thread)) deps.scheduleSave(thread);
  }
}

export function registerLineTracking(
  subscriptions: vscode.Disposable[],
  deps: LineTrackerDeps,
  anchorContextRadius: number,
  anchorSearchRadius: number,
): void {
  subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) =>
      applyLineTrackingChange(event, deps, anchorContextRadius, anchorSearchRadius),
    ),
  );
}
