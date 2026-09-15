import { expect, test } from 'vitest';
import { allocatePublicThreadId } from './identity';

test('keeps a persisted ID when it is not active in this window', () => {
  expect(allocatePublicThreadId(7, new Set([1, 2]), 3)).toEqual({ id: 7, nextId: 8 });
});

test('assigns a new public handle when separate scopes share a persisted ID', () => {
  expect(allocatePublicThreadId(1, new Set([1, 2]), 3)).toEqual({ id: 3, nextId: 4 });
});
