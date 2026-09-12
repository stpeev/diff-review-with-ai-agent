import { test } from 'vitest';
const assert = require('node:assert');
import {
  emptyBranch,
  emptyScopeFile,
  backfillStableIds,
  mergeScopeFiles,
  serializeComments,
  type SerializedThread,
} from './comment-store';

test('backfillStableIds deterministically upgrades legacy thread and comment identities', () => {
  const legacy = emptyScopeFile('writer');
  legacy.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      {
        id: 1,
        uri: 'file:///a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: 'Review', timestamp: '2026-01-01T00:00:00.000Z' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const first = backfillStableIds(legacy);
  const second = backfillStableIds(legacy);
  assert.deepStrictEqual(first, second);
  assert.ok(first.branches.main.threads[0].stableId);
  assert.ok(first.branches.main.threads[0].comments[0].stableId);
});

function thread(id: number, updatedAt: string, overrides: Partial<SerializedThread> = {}): SerializedThread {
  return Object.assign(
    {
      id,
      uri: 'file:///a.ts',
      startLine: 0,
      endLine: 0,
      status: 'open' as const,
      comments: [{ id: 1, role: 'user' as const, body: 'hi', timestamp: updatedAt }],
      updatedAt,
    },
    overrides || {},
  );
}

// --------------- mergeScopeFiles ---------------

test('mergeScopeFiles unions threads present on only one side', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = { nextThreadId: 2, nextCommentId: 2, threads: [thread(1, '2026-01-01T00:00:00Z')] };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = { nextThreadId: 3, nextCommentId: 3, threads: [thread(2, '2026-01-01T00:00:01Z')] };

  const merged = mergeScopeFiles(mine, theirs, 'writer-a');
  const ids = merged.branches.main.threads.map((t) => t.id).sort();
  assert.deepStrictEqual(ids, [1, 2]);
});

test('mergeScopeFiles keeps the later-updated version of a thread present on both sides', () => {
  const originalComment = { id: 1, role: 'user' as const, body: 'hi', timestamp: '2026-01-01T00:00:00Z' };
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [thread(1, '2026-01-01T00:00:00Z', { status: 'open', comments: [originalComment] })],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [thread(1, '2026-01-01T00:05:00Z', { status: 'resolved', comments: [originalComment] })],
  };

  const merged = mergeScopeFiles(mine, theirs, 'writer-a');
  assert.strictEqual(merged.branches.main.threads[0].status, 'resolved');
});

test('mergeScopeFiles uses a stable thread ID to reconcile divergent copies', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      thread(1, '2026-01-01T00:01:00Z', {
        stableId: 'thread-identity',
        comments: [{ id: 1, role: 'user', body: 'First copy', timestamp: '2026-01-01T00:01:00Z' }],
      }),
    ],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      thread(1, '2026-01-01T00:02:00Z', {
        stableId: 'thread-identity',
        comments: [{ id: 1, role: 'user', body: 'Second copy', timestamp: '2026-01-01T00:02:00Z' }],
      }),
    ],
  };

  const branch = mergeScopeFiles(mine, theirs, 'writer-a').branches.main;
  assert.strictEqual(branch.threads.length, 1);
  assert.strictEqual(branch.threads[0].stableId, 'thread-identity');
  assert.deepStrictEqual(
    branch.threads[0].comments.map((comment) => comment.body),
    ['First copy', 'Second copy'],
  );
});

test('mergeScopeFiles keeps concurrent creations that collide on a legacy numeric thread ID', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [thread(1, '2026-01-01T00:01:00Z', { uri: 'file:///first.ts' })],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [thread(1, '2026-01-01T00:02:00Z', { uri: 'file:///second.ts' })],
  };

  const branch = mergeScopeFiles(mine, theirs, 'writer-a').branches.main;
  assert.deepStrictEqual(branch.threads.map((entry) => entry.uri).sort(), ['file:///first.ts', 'file:///second.ts']);
  assert.strictEqual(new Set(branch.threads.map((entry) => entry.id)).size, 2);
  assert.ok(branch.nextThreadId > 2);
});

test('mergeScopeFiles uses stable comment IDs to reconcile divergent numeric handles', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      thread(1, '2026-01-01T00:01:00Z', {
        stableId: 'thread-identity',
        comments: [
          { id: 1, stableId: 'comment-identity', role: 'user', body: 'Original', timestamp: '2026-01-01T00:00:00Z' },
        ],
      }),
    ],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 9,
    nextCommentId: 9,
    threads: [
      thread(8, '2026-01-01T00:02:00Z', {
        stableId: 'thread-identity',
        comments: [
          { id: 8, stableId: 'comment-identity', role: 'user', body: 'Original', timestamp: '2026-01-01T00:00:00Z' },
        ],
      }),
    ],
  };

  const branch = mergeScopeFiles(mine, theirs, 'writer-a').branches.main;
  assert.deepStrictEqual(branch.threads[0].comments, [
    { id: 8, stableId: 'comment-identity', role: 'user', body: 'Original', timestamp: '2026-01-01T00:00:00Z' },
  ]);
});

test('mergeScopeFiles preserves independent replies to the same thread and remaps colliding comment IDs', () => {
  const originalComment = { id: 1, role: 'user' as const, body: 'Original review', timestamp: '2026-01-01T00:00:00Z' };
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 3,
    threads: [
      thread(1, '2026-01-01T00:01:00Z', {
        comments: [originalComment, { id: 2, role: 'agent', body: 'First reply', timestamp: '2026-01-01T00:01:00Z' }],
      }),
    ],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 3,
    threads: [
      thread(1, '2026-01-01T00:02:00Z', {
        comments: [originalComment, { id: 2, role: 'agent', body: 'Second reply', timestamp: '2026-01-01T00:02:00Z' }],
      }),
    ],
  };

  const branch = mergeScopeFiles(mine, theirs, 'writer-a').branches.main;
  assert.deepStrictEqual(
    branch.threads[0].comments.map((comment) => comment.body),
    ['Original review', 'First reply', 'Second reply'],
  );
  assert.strictEqual(new Set(branch.threads[0].comments.map((comment) => comment.id)).size, 3);
  assert.ok(branch.nextCommentId > 3);
});

test('mergeScopeFiles retains conflicting concurrent comment edits as recoverable comments', () => {
  const originalTimestamp = '2026-01-01T00:00:00Z';
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      thread(1, '2026-01-01T00:01:00Z', {
        comments: [{ id: 1, role: 'user', body: 'First edit', timestamp: originalTimestamp }],
      }),
    ],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      thread(1, '2026-01-01T00:02:00Z', {
        comments: [{ id: 1, role: 'user', body: 'Second edit', timestamp: originalTimestamp }],
      }),
    ],
  };

  const branch = mergeScopeFiles(mine, theirs, 'writer-a').branches.main;
  assert.deepStrictEqual(
    branch.threads[0].comments.map((comment) => comment.body),
    ['First edit', 'Second edit'],
  );
  assert.strictEqual(new Set(branch.threads[0].comments.map((comment) => comment.id)).size, 2);
});

test('mergeScopeFiles gives a recoverable conflicting stable comment a distinct identity', () => {
  const originalTimestamp = '2026-01-01T00:00:00Z';
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      thread(1, '2026-01-01T00:01:00Z', {
        stableId: 'thread-identity',
        comments: [
          { id: 1, stableId: 'comment-identity', role: 'user', body: 'First edit', timestamp: originalTimestamp },
        ],
      }),
    ],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      thread(1, '2026-01-01T00:02:00Z', {
        stableId: 'thread-identity',
        comments: [
          { id: 1, stableId: 'comment-identity', role: 'user', body: 'Second edit', timestamp: originalTimestamp },
        ],
      }),
    ],
  };

  const comments = mergeScopeFiles(mine, theirs, 'writer-a').branches.main.threads[0].comments;
  assert.deepStrictEqual(
    comments.map((comment) => comment.body),
    ['Second edit', 'First edit'],
  );
  assert.strictEqual(new Set(comments.map((comment) => comment.stableId)).size, 2);
  assert.ok(comments.some((comment) => comment.stableId === 'comment-identity'));
});

test('mergeScopeFiles keeps branches that exist on only one side', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = { ...emptyBranch(), threads: [thread(1, '2026-01-01T00:00:00Z')] };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.feature = { ...emptyBranch(), threads: [thread(2, '2026-01-01T00:00:00Z')] };

  const merged = mergeScopeFiles(mine, theirs, 'writer-a');
  assert.ok(merged.branches.main);
  assert.ok(merged.branches.feature);
});

test('mergeScopeFiles bumps the revision past both inputs', () => {
  const mine = { ...emptyScopeFile('writer-a'), revision: 3 };
  const theirs = { ...emptyScopeFile('writer-b'), revision: 5 };
  const merged = mergeScopeFiles(mine, theirs, 'writer-a');
  assert.strictEqual(merged.revision, 6);
});

test('mergeScopeFiles takes the max nextThreadId/nextCommentId per branch', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = { nextThreadId: 10, nextCommentId: 4, threads: [] };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = { nextThreadId: 3, nextCommentId: 9, threads: [] };
  const merged = mergeScopeFiles(mine, theirs, 'writer-a');
  assert.strictEqual(merged.branches.main.nextThreadId, 10);
  assert.strictEqual(merged.branches.main.nextCommentId, 9);
});

test('mergeScopeFiles keeps a newer deletion tombstone instead of resurrecting a racing thread', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [],
    deletedThreads: [{ id: 1, deletedAt: '2026-01-01T00:02:00Z' }],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [thread(1, '2026-01-01T00:01:00Z')],
  };

  const merged = mergeScopeFiles(mine, theirs, 'writer-a').branches.main;
  assert.deepStrictEqual(merged.threads, []);
  assert.deepStrictEqual(merged.deletedThreads, [{ id: 1, deletedAt: '2026-01-01T00:02:00Z' }]);
});

test('mergeScopeFiles retains a later edit and removes its stale deletion tombstone', () => {
  const mine = emptyScopeFile('writer-a');
  mine.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [],
    deletedThreads: [{ id: 1, deletedAt: '2026-01-01T00:01:00Z' }],
  };
  const theirs = emptyScopeFile('writer-b');
  theirs.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [thread(1, '2026-01-01T00:02:00Z')],
  };

  const merged = mergeScopeFiles(mine, theirs, 'writer-a').branches.main;
  assert.deepStrictEqual(
    merged.threads.map((entry) => entry.id),
    [1],
  );
  assert.deepStrictEqual(merged.deletedThreads, []);
});

test('serializeComments maps live comments to their persisted shape', () => {
  const out = serializeComments([
    { id: 3, role: 'user', body: 'plain string body', createdAt: '2026-01-01T00:00:00Z' },
    {
      id: 4,
      stableId: 'comment-identity',
      role: 'agent',
      body: { value: 'markdown body' },
      createdAt: '2026-01-02T00:00:00Z',
    },
  ]);
  assert.deepStrictEqual(out, [
    { id: 3, role: 'user', body: 'plain string body', timestamp: '2026-01-01T00:00:00Z' },
    { id: 4, stableId: 'comment-identity', role: 'agent', body: 'markdown body', timestamp: '2026-01-02T00:00:00Z' },
  ]);
});
