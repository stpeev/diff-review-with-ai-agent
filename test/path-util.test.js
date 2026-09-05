const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveWithinRoot } = require('../out/path-util');

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
