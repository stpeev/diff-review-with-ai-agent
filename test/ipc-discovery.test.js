const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
    descriptorDir, descriptorFileName, descriptorPath,
    deepestMatch, resolvePort,
    NoServerError, AmbiguousPortError,
} = require('../out/ipc-discovery');

// --------------- Descriptor paths ---------------

test('descriptorDir nests under a "diff-review" subdirectory of tmpdir', () => {
    assert.strictEqual(descriptorDir('/tmp'), path.join('/tmp', 'diff-review'));
});

test('descriptorFileName is stable for the same root set regardless of order', () => {
    const a = descriptorFileName(['/repo/a', '/repo/b'], 111);
    const b = descriptorFileName(['/repo/b', '/repo/a'], 222); // different pid, same roots
    assert.strictEqual(a, b);
});

test('descriptorFileName differs for different root sets', () => {
    const a = descriptorFileName(['/repo/a'], 111);
    const b = descriptorFileName(['/repo/b'], 111);
    assert.notStrictEqual(a, b);
});

test('descriptorFileName falls back to pid when there is no workspace folder', () => {
    const a = descriptorFileName([], 111);
    const b = descriptorFileName([], 222);
    assert.notStrictEqual(a, b);
});

test('descriptorPath joins dir and file name', () => {
    const p = descriptorPath('/tmp', ['/repo/a'], 1);
    assert.strictEqual(p, path.join(descriptorDir('/tmp'), descriptorFileName(['/repo/a'], 1)));
});

// --------------- deepestMatch ---------------

function d(port, workspaceRoots) {
    return { port, workspaceRoots, pid: port, startedAt: '2026-01-01T00:00:00.000Z' };
}

test('deepestMatch picks the descriptor whose root is the deepest ancestor', () => {
    const descriptors = [d(1000, ['/Users/dev/project']), d(2000, ['/Users/dev/project/packages/app'])];
    const match = deepestMatch(descriptors, '/Users/dev/project/packages/app/src/index.ts');
    assert.strictEqual(match.descriptor.port, 2000);
    assert.strictEqual(match.root, '/Users/dev/project/packages/app');
});

test('deepestMatch does not match a sibling that merely shares a prefix', () => {
    const descriptors = [d(1000, ['/Users/dev/project-foo'])];
    const match = deepestMatch(descriptors, '/Users/dev/project-foobar/src/index.ts');
    assert.strictEqual(match, undefined);
});

test('deepestMatch returns undefined when nothing matches', () => {
    const descriptors = [d(1000, ['/somewhere/else'])];
    assert.strictEqual(deepestMatch(descriptors, '/Users/dev/project'), undefined);
});

test('deepestMatch considers every root of a multi-root window', () => {
    const descriptors = [d(1000, ['/a', '/b/deep/nested'])];
    const match = deepestMatch(descriptors, '/b/deep/nested/file.ts');
    assert.strictEqual(match.root, '/b/deep/nested');
});

// --------------- resolvePort ---------------

test('resolvePort: --port flag wins over everything, even with no descriptors', () => {
    const got = resolvePort([], { portFlag: 9999, cwd: '/anywhere' });
    assert.deepStrictEqual(got, { port: 9999, matchedRoot: null, source: 'flag' });
});

test('resolvePort: throws NoServerError when no descriptors and no flag', () => {
    assert.throws(() => resolvePort([], { cwd: '/anywhere' }), NoServerError);
});

test('resolvePort: cwd match wins over a sole-live descriptor that does not match', () => {
    const descriptors = [d(1000, ['/other/project']), d(2000, ['/Users/dev/project'])];
    const got = resolvePort(descriptors, { cwd: '/Users/dev/project/src' });
    assert.strictEqual(got.port, 2000);
    assert.strictEqual(got.source, 'cwd-match');
    assert.strictEqual(got.matchedRoot, '/Users/dev/project');
});

test('resolvePort: falls back to the sole live descriptor when nothing matches cwd', () => {
    const descriptors = [d(1000, ['/Users/dev/project'])];
    const got = resolvePort(descriptors, { cwd: '/somewhere/unrelated' });
    assert.strictEqual(got.port, 1000);
    assert.strictEqual(got.source, 'sole-live');
});

test('resolvePort: throws AmbiguousPortError when multiple descriptors exist and none matches cwd', () => {
    const descriptors = [d(1000, ['/proj/a']), d(2000, ['/proj/b'])];
    assert.throws(() => resolvePort(descriptors, { cwd: '/unrelated' }), AmbiguousPortError);
});

test('resolvePort: a window with no workspace folder never wins a cwd match, but can be the sole-live fallback', () => {
    const descriptors = [d(1000, [])];
    const got = resolvePort(descriptors, { cwd: '/anywhere' });
    assert.strictEqual(got.source, 'sole-live');
    assert.strictEqual(got.matchedRoot, null);
});
