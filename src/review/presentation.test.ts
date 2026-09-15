import { expect, test } from 'vitest';
import { commentPreview, statusBarPresentation } from './presentation';

test('commentPreview renders the first plain or markdown body with a stable limit', () => {
  expect(commentPreview([])).toBe('');
  expect(commentPreview([{ body: { value: 'Markdown body' } }])).toBe('Markdown body');
  expect(commentPreview([{ body: 'abcdefgh' }], 7)).toBe('abcd...');
});

test('statusBarPresentation exposes review and persistence state without VS Code', () => {
  expect(statusBarPresentation(3, 2, 1, false)).toMatchObject({
    visible: true,
    text: '$(comment-discussion) 2 open · 1 resolved · 1 drifted',
  });
  expect(statusBarPresentation(0, 0, 0, true)).toMatchObject({
    visible: true,
    text: '$(warning) Diff Review: not persisted',
  });
  expect(statusBarPresentation(0, 0, 0, false)).toEqual({ visible: false });
});
