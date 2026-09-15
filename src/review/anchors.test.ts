import { expect, test } from 'vitest';
import { anchorContextSnippet, findAnchorLine, hashAnchor } from './anchors';

test('hashAnchor is stable for identical inputs and changes with its context', () => {
  expect(hashAnchor('const x = 1;', ['a', 'const x = 1;', 'b'])).toBe(
    hashAnchor('const x = 1;', ['a', 'const x = 1;', 'b']),
  );
  expect(hashAnchor('const x = 1;', ['before-a', 'const x = 1;', 'after'])).not.toBe(
    hashAnchor('const x = 1;', ['before-b', 'const x = 1;', 'after']),
  );
});

test('findAnchorLine matches an unchanged stored line', () => {
  const file = ['a', 'b', 'TARGET', 'c', 'd'];
  const hash = hashAnchor('TARGET', anchorContextSnippet(file, 2, 1).split('\n'));
  expect(findAnchorLine(file, hash, 2, 1, 50)).toBe(2);
});

test('findAnchorLine finds an anchor after a nearby or distant shift', () => {
  const original = ['a', 'b', 'TARGET', 'c', 'd'];
  const hash = hashAnchor('TARGET', anchorContextSnippet(original, 2, 1).split('\n'));
  expect(findAnchorLine(['x', 'y', ...original], hash, 2, 1, 50)).toBe(4);

  const distantOriginal = ['pad', 'pad', 'TARGET', 'pad', 'pad'];
  const distantHash = hashAnchor('TARGET', anchorContextSnippet(distantOriginal, 2, 1).split('\n'));
  expect(findAnchorLine([...Array(10).fill('x'), ...distantOriginal], distantHash, 0, 1, 3)).toBe(12);
});

test('findAnchorLine rejects absent and context-mismatched candidates', () => {
  expect(
    findAnchorLine(['completely', 'different', 'content'], hashAnchor('TARGET', ['a', 'TARGET', 'b']), 1, 1, 50),
  ).toBe(undefined);

  const original = ['ctx-a', 'DUPLICATE', 'ctx-b'];
  const hash = hashAnchor('DUPLICATE', anchorContextSnippet(original, 1, 1).split('\n'));
  expect(findAnchorLine(['other-a', 'DUPLICATE', 'other-b'], hash, 1, 1, 50)).toBe(undefined);
});
