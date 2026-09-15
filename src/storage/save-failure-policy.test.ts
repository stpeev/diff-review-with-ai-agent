import { expect, test } from 'vitest';
import { afterSaveFailure } from './save-failure-policy';

test('save failures retry with bounded backoff and preserve the error text', () => {
  expect(afterSaveFailure(0, new Error('disk unavailable'), false, 3)).toEqual({
    consecutiveSaveFailures: 1,
    lastSaveError: 'disk unavailable',
    retryDelayMs: 250,
    showWarning: false,
  });
  expect(afterSaveFailure(2, 'disk unavailable', false, 3)).toEqual({
    consecutiveSaveFailures: 3,
    lastSaveError: 'disk unavailable',
    retryDelayMs: 750,
    showWarning: true,
  });
});

test('shutdown and exhausted retries do not queue further save work', () => {
  expect(afterSaveFailure(0, new Error('disk unavailable'), true, 3).retryDelayMs).toBeUndefined();
  expect(afterSaveFailure(3, new Error('disk unavailable'), false, 3).retryDelayMs).toBeUndefined();
});
