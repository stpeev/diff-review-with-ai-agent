import { expect, test } from 'vitest';
import { hashAnchor } from '../../review/anchors';
import { anchorForFileLine } from './file-anchor';

test('anchorForFileLine produces the hash and context for a valid source line', () => {
  const result = anchorForFileLine('/workspace/file.ts', 1, () => 'before\ntarget\nafter', 1);
  expect(result).toEqual({
    anchorContext: 'before\ntarget\nafter',
    anchorHash: hashAnchor('target', ['before', 'target', 'after']),
  });
});

test('anchorForFileLine treats unreadable files and invalid lines as absent anchors', () => {
  expect(anchorForFileLine('/workspace/file.ts', -1, () => 'line', 2)).toBeUndefined();
  expect(anchorForFileLine('/workspace/file.ts', 1, () => 'line', 2)).toBeUndefined();
  expect(
    anchorForFileLine(
      '/workspace/file.ts',
      0,
      () => {
        throw new Error('unreadable');
      },
      2,
    ),
  ).toBeUndefined();
});
