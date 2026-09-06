const test = require('node:test');
const assert = require('node:assert');
const {
    normalizeRemoteUrl, scopeIdForRemote, scopeIdForRepo, scopeIdForFolder,
    scopeDirName, deepestScopeForFile,
} = require('../out/test/scope-id');

// --------------- normalizeRemoteUrl ---------------

test('normalizeRemoteUrl strips a trailing .git and slash', () => {
    assert.strictEqual(
        normalizeRemoteUrl('https://github.com/foo/bar.git'),
        normalizeRemoteUrl('https://github.com/foo/bar/'),
    );
});

test('normalizeRemoteUrl lower-cases the host but not the path', () => {
    const got = normalizeRemoteUrl('https://GitHub.com/Foo/Bar');
    assert.strictEqual(got, 'https://github.com/Foo/Bar');
});

test('normalizeRemoteUrl strips embedded credentials', () => {
    const withCreds = normalizeRemoteUrl('https://user:token@github.com/foo/bar.git');
    const without = normalizeRemoteUrl('https://github.com/foo/bar.git');
    assert.strictEqual(withCreds, without);
});

test('normalizeRemoteUrl converts scp-like ssh to a comparable form', () => {
    const scp = normalizeRemoteUrl('git@github.com:foo/bar.git');
    assert.strictEqual(scp, 'ssh://github.com/foo/bar');
});

test('normalizeRemoteUrl does not equate ssh and https for the same repo (documented limitation)', () => {
    const ssh = normalizeRemoteUrl('git@github.com:foo/bar.git');
    const https = normalizeRemoteUrl('https://github.com/foo/bar.git');
    assert.notStrictEqual(ssh, https);
});

// --------------- scope id formatting ---------------

test('scopeIdForRemote is prefixed and deterministic', () => {
    const a = scopeIdForRemote('https://github.com/foo/bar.git');
    const b = scopeIdForRemote('https://github.com/foo/bar');
    assert.strictEqual(a, b);
    assert.ok(a.startsWith('remote:'));
});

test('scopeIdForRepo hashes the realpath and is stable', () => {
    const a = scopeIdForRepo('/Users/dev/project');
    const b = scopeIdForRepo('/Users/dev/project');
    assert.strictEqual(a, b);
    assert.ok(a.startsWith('repo:'));
});

test('scopeIdForRepo differs for different paths', () => {
    assert.notStrictEqual(scopeIdForRepo('/a'), scopeIdForRepo('/b'));
});

test('scopeIdForFolder is distinguishable from scopeIdForRepo for the same path', () => {
    assert.notStrictEqual(scopeIdForFolder('/Users/dev/project'), scopeIdForRepo('/Users/dev/project'));
});

test('scopeDirName strips characters unsafe in a filesystem path', () => {
    const id = 'remote:https://github.com/foo/bar';
    const dir = scopeDirName(id);
    assert.ok(!/[:\/]/.test(dir));
});

// --------------- deepestScopeForFile ---------------

test('deepestScopeForFile picks the nested folder over the enclosing one', () => {
    const candidates = [
        { scopeId: 'folder:outer', folderRealPath: '/Users/dev/workspace' },
        { scopeId: 'repo:inner', folderRealPath: '/Users/dev/workspace/service-a' },
    ];
    const match = deepestScopeForFile(candidates, '/Users/dev/workspace/service-a/src/index.ts');
    assert.strictEqual(match.scopeId, 'repo:inner');
});

test('deepestScopeForFile keeps mixed git/non-git roots separate', () => {
    const candidates = [
        { scopeId: 'repo:git-one', folderRealPath: '/Users/dev/ws/git-repo' },
        { scopeId: 'folder:plain-one', folderRealPath: '/Users/dev/ws/plain-folder' },
    ];
    assert.strictEqual(deepestScopeForFile(candidates, '/Users/dev/ws/git-repo/a.ts').scopeId, 'repo:git-one');
    assert.strictEqual(deepestScopeForFile(candidates, '/Users/dev/ws/plain-folder/b.ts').scopeId, 'folder:plain-one');
});
