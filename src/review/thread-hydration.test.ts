import { expect, test, vi } from 'vitest';
import type { SerializedThread } from '../comment-store';
import { hydrateThreadLocation } from './thread-hydration';

function thread(overrides: Partial<SerializedThread> = {}): SerializedThread {
  return {
    id: 1,
    stableId: 'thread-1',
    uri: 'file:///workspace/a.ts',
    startLine: 4,
    endLine: 6,
    status: 'open',
    comments: [],
    updatedAt: 'now',
    anchorHash: 'anchor',
    anchorContext: 'context',
    ...overrides,
  };
}

test('hydrateThreadLocation preserves explicit file notes and drift without anchor lookup', () => {
  const verify = vi.fn(() => 9);

  expect(hydrateThreadLocation(thread({ fileNote: true }), verify)).toEqual({
    startLine: 0,
    endLine: 0,
    drifted: false,
  });
  expect(hydrateThreadLocation(thread({ drifted: true }), verify)).toMatchObject({
    startLine: 4,
    endLine: 6,
    drifted: true,
  });
  expect(verify).not.toHaveBeenCalled();
});

test('hydrateThreadLocation shifts anchored ranges by the verified start line', () => {
  expect(hydrateThreadLocation(thread(), () => 10)).toEqual({
    startLine: 10,
    endLine: 12,
    drifted: false,
    anchorHash: 'anchor',
    anchorContext: 'context',
  });
});

test('hydrateThreadLocation marks a failed anchor search as drifted', () => {
  expect(hydrateThreadLocation(thread(), () => 'drifted')).toEqual({ startLine: 4, endLine: 6, drifted: true });
});
