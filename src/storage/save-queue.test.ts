import { expect, test } from 'vitest';
import { SaveQueue, SaveQueueClosedError, SaveQueueDrainTimeoutError } from './save-queue';

test('SaveQueue debounces a scope and reports its lifecycle', async () => {
  const queue = new SaveQueue<string>();
  const calls: string[] = [];
  queue.schedule(
    'scope',
    async () => {
      calls.push('first');
    },
    1,
    () => undefined,
  );
  queue.schedule(
    'scope',
    async () => {
      calls.push('second');
    },
    1,
    () => undefined,
  );

  expect(queue.state('scope')).toBe('dirty');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await queue.flushAll();

  expect(calls).toEqual(['second']);
  expect(queue.state('scope')).toBe('saved');
});

test('SaveQueue preserves a failure for an explicit flush', async () => {
  const queue = new SaveQueue<string>();
  const failure = new Error('disk full');
  await expect(queue.flush('scope', async () => Promise.reject(failure))).rejects.toThrow('disk full');
  expect(queue.state('scope')).toBe('failed');
  expect(queue.error('scope')).toBe(failure);

  await queue.flush('scope', async () => undefined);
  expect(queue.state('scope')).toBe('saved');
  expect(queue.error('scope')).toBeUndefined();
});

test('SaveQueue reports a failure from an in-flight save during shutdown draining', async () => {
  const queue = new SaveQueue<string>();
  queue.schedule(
    'scope',
    async () => Promise.reject(new Error('disk full')),
    1,
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  await expect(queue.flushAll()).rejects.toThrow('disk full');
  expect(queue.state('scope')).toBe('failed');
});

test('SaveQueue reports a bounded shutdown timeout for an unresolved save', async () => {
  const queue = new SaveQueue<string>();
  void queue.flush('scope', async () => new Promise<void>(() => undefined)).catch(() => undefined);

  await expect(queue.flushAll(5)).rejects.toBeInstanceOf(SaveQueueDrainTimeoutError);
});

test('SaveQueue drains work already queued at shutdown and rejects later schedules', async () => {
  const queue = new SaveQueue<string>();
  const calls: string[] = [];
  queue.schedule(
    'scope',
    async () => {
      calls.push('before-close');
    },
    60_000,
    () => undefined,
  );

  queue.close();
  expect(
    queue.schedule(
      'scope',
      async () => {
        calls.push('after-close');
      },
      0,
      () => undefined,
    ),
  ).toBe(false);
  await queue.flushAll();

  expect(calls).toEqual(['before-close']);
  await expect(
    queue.flush('scope', async () => {
      calls.push('flush-after-close');
    }),
  ).rejects.toBeInstanceOf(SaveQueueClosedError);
});
