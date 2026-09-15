import { expect, test, vi } from 'vitest';
import { materializeStoredThread } from './stored-thread-materializer';

const serialized = {
  id: 2,
  stableId: 'thread-2',
  uri: 'file:///a.ts',
  startLine: 2,
  endLine: 3,
  status: 'open' as const,
  comments: [{ id: 3, stableId: 'comment-3', role: 'user' as const, body: 'Review this', timestamp: '' }],
  updatedAt: 'updated',
  anchorContext: 'context',
};

test('materializeStoredThread creates, tracks, and presents an anchored comment view', () => {
  const thread = {};
  const deps = {
    parseUri: vi.fn((value: string) => value),
    createThread: vi.fn(() => thread),
    createComment: vi.fn(() => ({ comment: true })),
    setComments: vi.fn(),
    setCanReply: vi.fn(),
    stableCommentId: vi.fn(() => 'stable-comment'),
    stableThreadId: vi.fn(() => 'stable-thread'),
    track: vi.fn(),
    present: vi.fn(),
    now: vi.fn(() => 'now'),
  };

  expect(
    materializeStoredThread(serialized, { startLine: 5, endLine: 6, drifted: false, anchorHash: 'anchor' }, deps),
  ).toBe(thread);
  expect(deps.createThread).toHaveBeenCalledWith('file:///a.ts', 5, 6);
  expect(deps.setCanReply).toHaveBeenCalledWith(thread, true);
  expect(deps.createComment).toHaveBeenCalledWith('Review this', 'user', 3, 'stable-comment', 'now');
  expect(deps.track).toHaveBeenCalledWith(
    thread,
    2,
    expect.objectContaining({ location: { kind: 'anchored', startLine: 5, endLine: 6 }, anchorContext: 'context' }),
    'stable-thread',
  );
  expect(deps.present).toHaveBeenCalledWith(thread, 'open');
});

test('materializeStoredThread keeps drifted locations informational and clamps negative lines', () => {
  const thread = {};
  const track = vi.fn();
  materializeStoredThread(
    { ...serialized, fileNote: true },
    { startLine: -2, endLine: -1, drifted: true },
    {
      parseUri: (value) => value,
      createThread: vi.fn(() => thread),
      createComment: () => ({}),
      setComments: () => undefined,
      setCanReply: () => undefined,
      stableCommentId: () => 'comment',
      stableThreadId: () => 'thread',
      track,
      present: () => undefined,
      now: () => 'now',
    },
  );

  expect(track).toHaveBeenCalledWith(
    thread,
    2,
    expect.objectContaining({ location: { kind: 'drifted', lastKnownLine: 0 } }),
    'thread',
  );
});
