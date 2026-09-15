import { expect, test } from 'vitest';
import { anchorContextSnippet, hashAnchor } from './anchors';
import { restoreAnchorLine } from './anchor-restoration';

test('restores anchors through a renamed file and reports missing anchors as drifted', () => {
  const lines = ['first', 'target', 'last'];
  const hash = hashAnchor(lines[1], anchorContextSnippet(lines, 1, 1).split('\n'));
  const deps = {
    fileExists: () => false,
    renamedPath: () => '/workspace/renamed.ts',
    readTextFile: () => lines.join('\n'),
  };

  expect(restoreAnchorLine('/workspace/old.ts', 1, hash, deps, 1, 10)).toBe(1);
  expect(restoreAnchorLine('/workspace/old.ts', 1, 'missing', deps, 1, 10)).toBe('drifted');
});

test('reports drift when a resolved anchor file cannot be read', () => {
  expect(
    restoreAnchorLine(
      '/workspace/a.ts',
      0,
      'anchor',
      {
        fileExists: () => true,
        renamedPath: () => undefined,
        readTextFile: () => {
          throw new Error('denied');
        },
      },
      1,
      10,
    ),
  ).toBe('drifted');
});
