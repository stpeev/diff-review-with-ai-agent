import { expect, test, vi } from 'vitest';
import { createLogger } from './logging';

test('createLogger formats the timestamp and product prefix at the logging boundary', () => {
  const write = vi.fn();

  createLogger({
    write,
    prefix: 'Diff Review',
    now: () => new Date('2026-09-15T20:00:00.000Z'),
  })('Comment created');

  expect(write).toHaveBeenCalledWith('[2026-09-15T20:00:00.000Z] [Diff Review] Comment created');
});
