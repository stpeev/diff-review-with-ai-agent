const test = require('node:test');
const assert = require('node:assert');
const { gitScopeFor } = require('../out/test/git-scope');

const REPO = '/Users/x/projects/thing';

test('gitScopeFor returns undefined while repo.state is still unpopulated', () => {
    // vscode.git registers a Repository before its first status refresh: no
    // remotes, no HEAD. Resolving here picks a repo: scope on branch
    // _detached.unknown and loads the wrong comments.json.
    assert.strictEqual(gitScopeFor({ remotes: [], HEAD: undefined }, REPO), undefined);
});

test('gitScopeFor returns undefined when HEAD is missing even though remotes arrived', () => {
    const state = { remotes: [{ fetchUrl: 'https://github.com/foo/bar.git' }], HEAD: undefined };
    assert.strictEqual(gitScopeFor(state, REPO), undefined);
});

test('gitScopeFor uses the remote for the scope and HEAD.name for the branch', () => {
    const state = {
        remotes: [{ fetchUrl: 'https://github.com/foo/bar.git' }],
        HEAD: { name: 'master', commit: 'abc123' },
    };
    assert.deepStrictEqual(gitScopeFor(state, REPO), {
        scopeId: 'remote:https://github.com/foo/bar',
        branchKey: 'master',
    });
});

test('gitScopeFor falls back to a repo: scope for a populated repo with no remote', () => {
    const state = { remotes: [], HEAD: { name: 'main', commit: 'abc123' } };
    const got = gitScopeFor(state, REPO);
    assert.match(got.scopeId, /^repo:[0-9a-f]{32}$/);
    assert.strictEqual(got.branchKey, 'main');
});

test('gitScopeFor keys a detached HEAD by its short sha', () => {
    const state = { remotes: [], HEAD: { name: undefined, commit: 'abcdef1234567890' } };
    assert.strictEqual(gitScopeFor(state, REPO).branchKey, '_detached.abcdef12');
});

test('gitScopeFor prefers pushUrl when fetchUrl is absent', () => {
    const state = {
        remotes: [{ pushUrl: 'git@github.com:foo/bar.git' }],
        HEAD: { name: 'main' },
    };
    assert.strictEqual(gitScopeFor(state, REPO).scopeId, 'remote:ssh://github.com/foo/bar');
});
