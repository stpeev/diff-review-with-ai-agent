/**
 * Application operations for review threads. Adapters own presentation and
 * storage mechanics; this service owns the result contract shared by them.
 */
export interface AgentReplyRecord {
  commentId: number;
  drifted: boolean;
}

export type ReplyAuthor = 'agent' | 'user';

export interface ReviewThreadStore<Thread> {
  find(threadId: number): Thread | undefined;
  create(thread: Thread, text: string, author: ReplyAuthor): { threadId: number };
  appendReply(thread: Thread, text: string, author: ReplyAuthor): AgentReplyRecord;
  beginEditing(thread: Thread, commentId: number): boolean;
  cancelEditing(thread: Thread, commentId: number): boolean;
  saveEditedComment(thread: Thread, commentId: number): boolean;
  deleteComment(threadId: number, thread: Thread, commentId: number): { threadDeleted: boolean } | undefined;
  markDrifted(thread: Thread): boolean;
  reattach(thread: Thread, line: number): boolean;
  keepAsFileNote(thread: Thread): boolean;
  resolve(thread: Thread): { drifted: boolean };
  unresolve(thread: Thread): void;
  delete(threadId: number, thread: Thread): { drifted: boolean };
}

export type AgentReplyResult =
  | { ok: true; commentId: number; drifted: boolean }
  | { ok: false; code: 'not-found' | 'invalid-text'; message: string };

export type CreateThreadResult = { ok: true; threadId: number } | { ok: false; code: 'invalid-text'; message: string };

export type CommentMutationFailureCode = 'not-found' | 'comment-not-found' | 'invalid-location';

export type CommentMutationResult =
  | { ok: true; threadDeleted?: boolean }
  | { ok: false; code: CommentMutationFailureCode; message: string };

export class ReviewService<Thread> {
  constructor(private readonly replies: ReviewThreadStore<Thread>) {}

  create(thread: Thread, text: string, author: ReplyAuthor): CreateThreadResult {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, code: 'invalid-text', message: 'A review comment must contain text.' };
    }
    return { ok: true, ...this.replies.create(thread, text, author) };
  }

  replyFromAgent(threadId: number, text: string): AgentReplyResult {
    return this.reply(threadId, text, 'agent');
  }

  replyFromUser(threadId: number, text: string): AgentReplyResult {
    return this.reply(threadId, text, 'user');
  }

  beginEditing(threadId: number, commentId: number): CommentMutationResult {
    return this.mutateComment(threadId, commentId, (thread) => this.replies.beginEditing(thread, commentId));
  }

  cancelEditing(threadId: number, commentId: number): CommentMutationResult {
    return this.mutateComment(threadId, commentId, (thread) => this.replies.cancelEditing(thread, commentId));
  }

  saveEditedComment(threadId: number, commentId: number): CommentMutationResult {
    return this.mutateComment(threadId, commentId, (thread) => this.replies.saveEditedComment(thread, commentId));
  }

  private mutateComment(
    threadId: number,
    commentId: number,
    operation: (thread: Thread) => boolean,
  ): CommentMutationResult {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    if (!Number.isSafeInteger(commentId) || commentId < 1 || !operation(thread.value)) {
      return {
        ok: false,
        code: 'comment-not-found',
        message: `Comment #${commentId} not found in thread #${threadId}.`,
      };
    }
    return { ok: true };
  }

  deleteComment(threadId: number, commentId: number): CommentMutationResult {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      return {
        ok: false,
        code: 'comment-not-found',
        message: `Comment #${commentId} not found in thread #${threadId}.`,
      };
    }
    const result = this.replies.deleteComment(threadId, thread.value, commentId);
    return result
      ? { ok: true, ...result }
      : { ok: false, code: 'comment-not-found', message: `Comment #${commentId} not found in thread #${threadId}.` };
  }

  markDrifted(threadId: number): CommentMutationResult {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    return this.replies.markDrifted(thread.value)
      ? { ok: true }
      : { ok: false, code: 'invalid-location', message: `Thread #${threadId} cannot be marked as drifted.` };
  }

  reattach(threadId: number, line: number): CommentMutationResult {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    if (!Number.isSafeInteger(line) || line < 0) {
      return {
        ok: false,
        code: 'invalid-location',
        message: 'A re-attached review location needs a non-negative line.',
      };
    }
    return this.replies.reattach(thread.value, line)
      ? { ok: true }
      : { ok: false, code: 'invalid-location', message: `Thread #${threadId} cannot be re-attached.` };
  }

  keepAsFileNote(threadId: number): CommentMutationResult {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    return this.replies.keepAsFileNote(thread.value)
      ? { ok: true }
      : { ok: false, code: 'invalid-location', message: `Thread #${threadId} cannot become a file note.` };
  }

  private reply(threadId: number, text: string, author: ReplyAuthor): AgentReplyResult {
    if (!Number.isSafeInteger(threadId) || threadId < 1) {
      return { ok: false, code: 'not-found', message: `Thread #${threadId} not found.` };
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, code: 'invalid-text', message: 'A reply must contain text.' };
    }

    const thread = this.replies.find(threadId);
    if (!thread) return { ok: false, code: 'not-found', message: `Thread #${threadId} not found.` };

    const reply = this.replies.appendReply(thread, text, author);
    return { ok: true, ...reply };
  }

  resolve(threadId: number): { ok: true; drifted: boolean } | { ok: false; code: 'not-found'; message: string } {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    return { ok: true, ...this.replies.resolve(thread.value) };
  }

  unresolve(threadId: number): { ok: true } | { ok: false; code: 'not-found'; message: string } {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    this.replies.unresolve(thread.value);
    return { ok: true };
  }

  delete(threadId: number): { ok: true; drifted: boolean } | { ok: false; code: 'not-found'; message: string } {
    const thread = this.find(threadId);
    if (thread.ok === false) return thread;
    return { ok: true, ...this.replies.delete(threadId, thread.value) };
  }

  private find(threadId: number): { ok: true; value: Thread } | { ok: false; code: 'not-found'; message: string } {
    if (!Number.isSafeInteger(threadId) || threadId < 1) {
      return { ok: false, code: 'not-found', message: `Thread #${threadId} not found.` };
    }
    const value = this.replies.find(threadId);
    return value ? { ok: true, value } : { ok: false, code: 'not-found', message: `Thread #${threadId} not found.` };
  }
}
