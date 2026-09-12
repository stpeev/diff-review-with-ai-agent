import assert from 'node:assert/strict';
import { test } from 'vitest';
import { gitScopeFor } from './git-scope';

const REPO = '/Users/x/projects/thing';
type GitState = {
  remotes: { fetchUrl?: string; pushUrl?: string }[];
  HEAD?: { name?: string; commit?: string };
};

test('gitScopeFor returns undefined while repo.state is still unpopulated', () => {
  // vscode.git registers a Repository before its first status refresh: no
  // remotes, no HEAD. Resolving here picks a repo: scope on branch
  // _detached.unknown and loads the wrong comments.json.
  assert.strictEqual(gitScopeFor({ remotes: [], HEAD: undefined }, REPO), undefined);
});

test('gitScopeFor returns undefined when HEAD is missing even though remotes arrived', () => {
  const state: GitState = { remotes: [{ fetchUrl: 'https://github.com/foo/bar.git' }], HEAD: undefined };
  assert.strictEqual(gitScopeFor(state, REPO), undefined);
});

test('gitScopeFor uses the remote for the scope and HEAD.name for the branch', () => {
  const state: GitState = {
    remotes: [{ fetchUrl: 'https://github.com/foo/bar.git' }],
    HEAD: { name: 'master', commit: 'abc123' },
  };
  assert.deepStrictEqual(gitScopeFor(state, REPO), {
    scopeId: 'remote:https://github.com/foo/bar',
    branchKey: 'master',
  });
});

test('gitScopeFor falls back to a repo: scope for a populated repo with no remote', () => {
  const state: GitState = { remotes: [], HEAD: { name: 'main', commit: 'abc123' } };
  const got = gitScopeFor(state, REPO);
  assert.ok(got);
  assert.match(got.scopeId, /^repo:[0-9a-f]{32}$/);
  assert.strictEqual(got.branchKey, 'main');
});

test('gitScopeFor keys a detached HEAD by its short sha', () => {
  const state: GitState = { remotes: [], HEAD: { name: undefined, commit: 'abcdef1234567890' } };
  const got = gitScopeFor(state, REPO);
  assert.ok(got);
  assert.strictEqual(got.branchKey, '_detached.abcdef12');
});

test('gitScopeFor prefers pushUrl when fetchUrl is absent', () => {
  const state: GitState = {
    remotes: [{ pushUrl: 'git@github.com:foo/bar.git' }],
    HEAD: { name: 'main' },
  };
  const got = gitScopeFor(state, REPO);
  assert.ok(got);
  assert.strictEqual(got.scopeId, 'remote:ssh://github.com/foo/bar');
});
