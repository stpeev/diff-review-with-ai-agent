import { expect, test } from 'vitest';
import { ReviewThreadIndex } from './thread-index';

test('ReviewThreadIndex preserves unique persisted handles and allocates around collisions', () => {
  const index = new ReviewThreadIndex<object, { state: string }>();
  const first = {};
  const second = {};
  const third = {};

  expect(index.track(first, { state: 'first' }, 4, 'stable-first')).toBe(4);
  expect(index.track(second, { state: 'second' }, 4)).toBe(5);
  expect(index.track(third, { state: 'third' })).toBe(6);
  expect(index.publicId(first)).toBe(4);
  expect(index.storageId(first)).toBe(4);
  expect(index.stableId(first)).toBe('stable-first');
  expect(index.publicId(second)).toBe(5);
  expect(index.storageId(second)).toBe(4);
  expect(index.metadata(second)).toEqual({ state: 'second' });
  expect([...index.ids()]).toEqual([4, 5, 6]);
  expect(index.get(5)).toBe(second);
  expect(index.remove(5)).toBe(true);
  expect(index.has(5)).toBe(false);
  expect(index.size).toBe(2);
});
