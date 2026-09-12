import { describe, expect, test, vi } from 'vitest';
import { anchoredLocation, driftedLocation } from '../../review/model';

vi.mock('vscode', () => ({
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  CommentMode: { Preview: 0, Editing: 1 },
  Range: class Range {
    constructor(
      readonly startLine: number,
      readonly _startCharacter: number,
      readonly endLine: number,
      readonly _endCharacter: number,
    ) {}
    get start() {
      return { line: this.startLine };
    }
    get end() {
      return { line: this.endLine };
    }
  },
}));

import { createVsCodeReviewThreadStore, type ThreadLocationMetadata } from './review-thread-store';
import { ReviewComment } from './review-comment';
import { presentReviewThread } from './review-thread-presentation';
import { requireThreadRange } from './thread-location';

interface FakeComment {
  id: number;
  body: string;
  mode?: number;
}

interface FakeThread {
  uri: { path: string };
  range: { start: { line: number }; end: { line: number } } | undefined;
  comments: FakeComment[];
  canReply: boolean;
  collapsibleState?: number;
  label?: string;
  contextValue?: string;
  state?: number;
  disposed?: boolean;
  dispose(): void;
}

function makeStore() {
  const threads = new Map<number, FakeThread>();
  const metadata = new WeakMap<FakeThread, ThreadLocationMetadata>();
  let nextCommentId = 1;
  let nextThreadId = 1;
  const effects = {
    refreshes: 0,
    threadSaves: 0,
    uriSaves: 0,
    deleted: [] as number[],
    presented: [] as Array<'open' | 'resolved' | undefined>,
    touched: 0,
  };
  const store = createVsCodeReviewThreadStore({
    find: (id) => threads.get(id) as never,
    createComment: (text) => ({ id: nextCommentId++, body: text }) as never,
    commentId: (comment) => (comment as unknown as FakeComment).id,
    isDrifted: (thread) => metadata.get(thread as unknown as FakeThread)?.location.kind === 'drifted',
    metadata: (thread) => metadata.get(thread as unknown as FakeThread),
    anchorForLine: (_uri, line) => ({ anchorHash: `anchor:${line}`, anchorContext: `line ${line}` }),
    track: (thread, anchor) => {
      const id = nextThreadId++;
      const fake = thread as unknown as FakeThread;
      threads.set(id, fake);
      metadata.set(fake, {
        location: anchoredLocation(fake.range!.start.line, fake.range!.end.line),
        anchorHash: anchor?.anchorHash,
        anchorContext: anchor?.anchorContext,
      });
      return id;
    },
    untrack: (id) => threads.delete(id),
    recordDeletion: (_thread, id) => effects.deleted.push(id),
    present: (_thread, status) => effects.presented.push(status),
    touch: () => effects.touched++,
    refresh: () => effects.refreshes++,
    queueSaveForThread: () => effects.threadSaves++,
    queueSaveForUri: () => effects.uriSaves++,
  });
  const thread = (): FakeThread => ({
    uri: { path: '/workspace/a.ts' },
    range: { start: { line: 4 }, end: { line: 4 } },
    comments: [],
    canReply: false,
    dispose() {
      this.disposed = true;
    },
  });
  return { store, threads, metadata, effects, thread };
}

describe('VS Code review thread store', () => {
  test('requires an actionable editor range', () => {
    const { thread } = makeStore();
    expect(requireThreadRange(thread() as never).start.line).toBe(4);
    expect(() => requireThreadRange({ range: undefined } as never)).toThrow('no longer has an editor location');
  });

  test('renders domain metadata onto a VS Code thread', () => {
    const { thread } = makeStore();
    const view = thread();
    const metadata = {
      status: 'open' as const,
      location: anchoredLocation(4),
      updatedAt: '2026-09-12T12:00:00.000Z',
    };

    presentReviewThread(view as never, metadata, 'resolved');

    expect(metadata.status).toBe('resolved');
    expect(view).toMatchObject({ label: '✅ Resolved', contextValue: 'resolved', state: 1, collapsibleState: 0 });
  });

  test('renders persisted role and timestamp as a VS Code comment', () => {
    const comment = new ReviewComment('Fixed', 'agent', 7, 'comment-identity', '2026-09-12T12:00:00.000Z');

    expect(comment).toMatchObject({
      id: 7,
      stableId: 'comment-identity',
      body: 'Fixed',
      role: 'agent',
      contextValue: 'agentComment',
      author: { name: '🤖 Agent' },
      createdAt: '2026-09-12T12:00:00.000Z',
    });
    expect(comment.timestamp.toISOString()).toBe('2026-09-12T12:00:00.000Z');
  });

  test('creates and replies through explicit view and persistence effects', () => {
    const { store, threads, effects, thread } = makeStore();
    const first = thread();

    expect(store.create(first as never, 'First finding', 'user')).toEqual({ threadId: 1 });
    expect(first.comments.map((comment) => comment.body)).toEqual(['First finding']);
    expect(first.canReply).toBe(true);
    expect(effects).toMatchObject({ refreshes: 1, threadSaves: 1 });

    expect(store.appendReply(threads.get(1) as never, 'Fixed', 'agent')).toEqual({ commentId: 2, drifted: false });
    expect(first.comments.map((comment) => comment.body)).toEqual(['First finding', 'Fixed']);
    expect(effects.threadSaves).toBe(2);
  });

  test('updates drifted locations and removes a last comment with a tombstone effect', () => {
    const { store, threads, metadata, effects, thread } = makeStore();
    const first = thread();
    store.create(first as never, 'First finding', 'user');
    metadata.get(first)!.location = driftedLocation(4);

    expect(store.reattach(threads.get(1) as never, 9)).toBe(true);
    expect(metadata.get(first)?.location).toEqual(anchoredLocation(9));
    expect(first.range?.start.line).toBe(9);

    expect(store.deleteComment(1, first as never, 1)).toEqual({ threadDeleted: true });
    expect(first.disposed).toBe(true);
    expect(threads.has(1)).toBe(false);
    expect(effects.deleted).toEqual([1]);
    expect(effects.uriSaves).toBe(1);
  });

  test('marks a tracked anchored location drifted through the view adapter', () => {
    const { store, metadata, effects, thread } = makeStore();
    const first = thread();
    store.create(first as never, 'First finding', 'user');

    expect(store.markDrifted(first as never)).toBe(true);
    expect(metadata.get(first)?.location).toEqual(driftedLocation(4));
    expect(metadata.get(first)?.anchorHash).toBeUndefined();
    expect(effects.uriSaves).toBe(1);
    expect(store.markDrifted(first as never)).toBe(false);
  });

  test('saves edits, converts drifted threads to file notes, and presents status transitions', () => {
    const { store, threads, metadata, effects, thread } = makeStore();
    const first = thread();
    store.create(first as never, 'First finding', 'user');
    store.appendReply(threads.get(1) as never, 'Reply', 'agent');

    expect(store.beginEditing(first as never, 2)).toBe(true);
    expect(first.comments[1].mode).toBe(1);
    expect(store.cancelEditing(first as never, 2)).toBe(true);
    expect(first.comments[1].mode).toBe(0);
    expect(store.saveEditedComment(first as never, 2)).toBe(true);
    expect(first.comments[1].mode).toBe(0);
    expect(store.saveEditedComment(first as never, 99)).toBe(false);

    metadata.get(first)!.location = driftedLocation(4);
    expect(store.keepAsFileNote(first as never)).toBe(true);
    expect(metadata.get(first)?.location).toEqual({ kind: 'file-note' });
    expect(store.keepAsFileNote(first as never)).toBe(false);

    expect(store.resolve(first as never)).toEqual({ drifted: false });
    store.unresolve(first as never);
    expect(effects.presented).toContain('resolved');
    expect(effects.presented).toContain('open');
    expect(effects.touched).toBeGreaterThanOrEqual(4);

    expect(store.delete(1, first as never)).toEqual({ drifted: false });
    expect(first.disposed).toBe(true);
    expect(threads.has(1)).toBe(false);
  });
});
