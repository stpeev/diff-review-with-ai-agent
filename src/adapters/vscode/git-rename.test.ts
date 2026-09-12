import { expect, test } from 'vitest';
import { renamedPathFor } from './git-rename';

test('renamedPathFor finds a renamed file across working-tree and index changes', () => {
  expect(
    renamedPathFor('/repo/old.ts', [
      [{ originalUri: { fsPath: '/repo/other.ts' }, uri: { fsPath: '/repo/other-new.ts' } }],
      [{ originalUri: { fsPath: '/repo/old.ts' }, uri: { fsPath: '/repo/new.ts' } }],
    ]),
  ).toBe('/repo/new.ts');
});

test('renamedPathFor ignores missing lists, non-renames, and unrelated changes', () => {
  expect(renamedPathFor('/repo/old.ts', [undefined, [{ uri: { fsPath: '/repo/new.ts' } }]])).toBeUndefined();
});
