import { expect, test } from 'vitest';
import { ReviewWaiters } from './review-waiters';

test('ReviewWaiters announces successive generations to each current waiter once', () => {
  const waiters = new ReviewWaiters();
  const seen: number[] = [];
  const unsubscribe = waiters.subscribe((generation) => seen.push(generation));
  expect(waiters.announce()).toEqual({ generation: 1, waiterCount: 1 });
  expect(seen).toEqual([1]);
  expect(waiters.size).toBe(0);

  unsubscribe();
  waiters.subscribe((generation) => seen.push(generation));
  expect(waiters.announce()).toEqual({ generation: 2, waiterCount: 1 });
  expect(seen).toEqual([1, 2]);
});

test('ReviewWaiters supports cancellation before an announcement', () => {
  const waiters = new ReviewWaiters();
  const listener = () => {
    throw new Error('cancelled waiter must not run');
  };
  const unsubscribe = waiters.subscribe(listener);
  unsubscribe();
  expect(waiters.announce()).toEqual({ generation: 1, waiterCount: 0 });
});

test('ReviewWaiters retains a waiter subscribed by an announcement callback', () => {
  const waiters = new ReviewWaiters();
  const seen: number[] = [];
  waiters.subscribe((generation) => {
    seen.push(generation);
    waiters.subscribe((nextGeneration) => seen.push(nextGeneration));
  });

  expect(waiters.announce()).toEqual({ generation: 1, waiterCount: 1 });
  expect(waiters.size).toBe(1);
  expect(waiters.announce()).toEqual({ generation: 2, waiterCount: 1 });
  expect(seen).toEqual([1, 2]);
});
