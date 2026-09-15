import * as vscode from 'vscode';
import { anchoredLocation, driftedLocation, fileNoteLocation, type ReviewLocation } from '../../review/model';
import type { ReplyAuthor, ReviewThreadStore } from '../../review/service';

export interface ThreadLocationMetadata {
  location: ReviewLocation;
  anchorHash?: string;
  anchorContext?: string;
}

export interface VsCodeReviewThreadStoreDeps {
  find(threadId: number): vscode.CommentThread | undefined;
  createComment(text: string, author: ReplyAuthor): vscode.Comment;
  commentId(comment: vscode.Comment): number | undefined;
  isDrifted(thread: vscode.CommentThread): boolean;
  metadata(thread: vscode.CommentThread): ThreadLocationMetadata | undefined;
  anchorForLine(uri: vscode.Uri, line: number): { anchorHash: string; anchorContext: string } | undefined;
  track(thread: vscode.CommentThread, anchor?: { anchorHash: string; anchorContext: string }): number;
  untrack(threadId: number): void;
  recordDeletion(thread: vscode.CommentThread, threadId: number): void;
  present(thread: vscode.CommentThread, status?: 'open' | 'resolved'): void;
  touch(thread: vscode.CommentThread): void;
  refresh(): void;
  queueSaveForThread(thread: vscode.CommentThread): void;
  queueSaveForUri(uri: vscode.Uri): void;
}

/**
 * The VS Code view adapter for review operations. It holds no global state:
 * the extension supplies the small set of view and persistence effects it
 * owns, while ReviewService remains the single operation entry point.
 */
export function createVsCodeReviewThreadStore(
  deps: VsCodeReviewThreadStoreDeps,
): ReviewThreadStore<vscode.CommentThread> {
  return {
    find: deps.find,
    create: (thread, text, author) => {
      thread.comments = [deps.createComment(text, author)];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = true;
      const threadId = deps.track(thread, deps.anchorForLine(thread.uri, thread.range?.start.line ?? 0));
      deps.present(thread, 'open');
      deps.refresh();
      deps.queueSaveForThread(thread);
      return { threadId };
    },
    appendReply: (thread, text, author) => {
      const drifted = deps.isDrifted(thread);
      const reply = deps.createComment(text, author);
      thread.comments = [...thread.comments, reply];
      if (!drifted) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      deps.touch(thread);
      deps.queueSaveForThread(thread);
      return { commentId: deps.commentId(reply)!, drifted };
    },
    beginEditing: (thread, commentId) => {
      const comment = thread.comments.find((candidate) => deps.commentId(candidate) === commentId);
      if (!comment) return false;
      comment.mode = vscode.CommentMode.Editing;
      thread.comments = [...thread.comments];
      return true;
    },
    cancelEditing: (thread, commentId) => {
      const comment = thread.comments.find((candidate) => deps.commentId(candidate) === commentId);
      if (!comment) return false;
      comment.mode = vscode.CommentMode.Preview;
      thread.comments = [...thread.comments];
      return true;
    },
    saveEditedComment: (thread, commentId) => {
      const comment = thread.comments.find((candidate) => deps.commentId(candidate) === commentId);
      if (!comment) return false;
      comment.mode = vscode.CommentMode.Preview;
      thread.comments = [...thread.comments];
      deps.touch(thread);
      deps.queueSaveForThread(thread);
      return true;
    },
    deleteComment: (threadId, thread, commentId) => {
      const comment = thread.comments.find((candidate) => deps.commentId(candidate) === commentId);
      if (!comment) return undefined;
      if (thread.comments.length <= 1) {
        deps.recordDeletion(thread, threadId);
        deps.untrack(threadId);
        thread.dispose();
        deps.refresh();
        deps.queueSaveForUri(thread.uri);
        return { threadDeleted: true };
      }
      thread.comments = thread.comments.filter((candidate) => candidate !== comment);
      deps.touch(thread);
      deps.refresh();
      deps.queueSaveForThread(thread);
      return { threadDeleted: false };
    },
    markDrifted: (thread) => {
      const meta = deps.metadata(thread);
      const range = thread.range;
      if (!meta || meta.location.kind !== 'anchored' || !range) return false;
      meta.location = driftedLocation(range.start.line);
      // A failed anchor must not be retained: loading it later could turn a
      // known-stale location back into an actionable editor range.
      meta.anchorHash = undefined;
      deps.present(thread);
      deps.touch(thread);
      deps.refresh();
      deps.queueSaveForUri(thread.uri);
      return true;
    },
    reattach: (thread, line) => {
      const meta = deps.metadata(thread);
      if (!meta || meta.location.kind !== 'drifted') return false;
      const anchor = deps.anchorForLine(thread.uri, line);
      thread.range = new vscode.Range(line, 0, line, 0);
      meta.location = anchoredLocation(line);
      meta.anchorHash = anchor?.anchorHash;
      meta.anchorContext = anchor?.anchorContext ?? meta.anchorContext;
      deps.present(thread);
      deps.touch(thread);
      deps.refresh();
      deps.queueSaveForThread(thread);
      return true;
    },
    keepAsFileNote: (thread) => {
      const meta = deps.metadata(thread);
      if (!meta || meta.location.kind !== 'drifted') return false;
      thread.range = new vscode.Range(0, 0, 0, 0);
      meta.anchorHash = undefined;
      meta.location = fileNoteLocation();
      deps.present(thread);
      deps.touch(thread);
      deps.refresh();
      deps.queueSaveForThread(thread);
      return true;
    },
    resolve: (thread) => {
      const drifted = deps.isDrifted(thread);
      deps.present(thread, 'resolved');
      deps.touch(thread);
      deps.refresh();
      deps.queueSaveForThread(thread);
      return { drifted };
    },
    unresolve: (thread) => {
      deps.present(thread, 'open');
      deps.touch(thread);
      deps.refresh();
      deps.queueSaveForThread(thread);
    },
    delete: (threadId, thread) => {
      const drifted = deps.isDrifted(thread);
      const uri = thread.uri;
      deps.recordDeletion(thread, threadId);
      deps.untrack(threadId);
      thread.dispose();
      deps.refresh();
      deps.queueSaveForUri(uri);
      return { drifted };
    },
  };
}
