import { test } from 'vitest';
const assert = require('node:assert');
const path = require('path');
import { resolveExistingWorkspacePath, resolveWithinRoot } from './path-util';

test('resolveWithinRoot joins a plain relative path onto the root', () => {
  const result = resolveWithinRoot('/repo', 'src/foo.ts');
  assert.strictEqual(result, path.join('/repo', 'src/foo.ts'));
});

test('resolveWithinRoot allows the root itself via "."', () => {
  assert.strictEqual(resolveWithinRoot('/repo', '.'), path.resolve('/repo'));
});

test('resolveWithinRoot rejects a path that escapes the root via ../', () => {
  assert.strictEqual(resolveWithinRoot('/repo', '../etc/passwd'), undefined);
});

test('resolveWithinRoot rejects a path that escapes deeper in the traversal', () => {
  assert.strictEqual(resolveWithinRoot('/repo', 'src/../../etc/passwd'), undefined);
});

test('resolveWithinRoot rejects an absolute path outside the root', () => {
  assert.strictEqual(resolveWithinRoot('/repo', '/etc/passwd'), undefined);
});

test('resolveWithinRoot accepts an absolute path that is inside the root', () => {
  assert.strictEqual(resolveWithinRoot('/repo', '/repo/src/foo.ts'), path.join('/repo', 'src/foo.ts'));
});

test('resolveWithinRoot does not treat a sibling with a matching prefix as inside the root', () => {
  assert.strictEqual(resolveWithinRoot('/repo', '../repo-other/foo.ts'), undefined);
});

test('resolveExistingWorkspacePath confines lookup and distinguishes empty, escaping, and missing paths', () => {
  const exists = (candidate: string) => candidate === path.join('/repo-b', 'found.ts');
  assert.deepStrictEqual(resolveExistingWorkspacePath([], 'found.ts', exists), {
    error: 'No workspace folder is open.',
  });
  assert.deepStrictEqual(resolveExistingWorkspacePath(['/repo-a'], '../secret.ts', exists), {
    error: 'Path "../secret.ts" escapes the workspace root.',
  });
  assert.deepStrictEqual(resolveExistingWorkspacePath(['/repo-a'], 'missing.ts', exists), {
    error: 'File not found: missing.ts',
  });
  assert.strictEqual(
    resolveExistingWorkspacePath(['/repo-a', '/repo-b'], 'found.ts', exists),
    path.join('/repo-b', 'found.ts'),
  );
});
