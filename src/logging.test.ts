import { expect, test, vi } from 'vitest';
import { createPrefixedLogger } from './logging';

test('createPrefixedLogger adds the product prefix once at the logging boundary', () => {
  const write = vi.fn();

  createPrefixedLogger(write, 'Diff Review')('Comment created');

  expect(write).toHaveBeenCalledWith('[Diff Review] Comment created');
});
