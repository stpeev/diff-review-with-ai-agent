const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRoster, resolveBinding, codexThreadIdFromMeta, claudePidFromSocketPath } = require('../out/test/agent-roster.js');
const session = (id, recency) => ({ agent: 'codex', sessionId: id, label: id, cwd: '/work', recency });

test('registration is idempotent and preserves registeredAt', () => {
    const roster = new AgentRoster();
    const first = roster.register(session('one', 1), new Date('2026-01-01'));
    const second = roster.register(session('one', 2), new Date('2026-01-02'));
    assert.equal(roster.list().length, 1);
    assert.equal(second.registeredAt, first.registeredAt);
    assert.notEqual(second.lastSeenAt, first.lastSeenAt);
});

test('sessions are ordered by recency', () => {
    const roster = new AgentRoster();
    roster.register(session('old', 1)); roster.register(session('new', 2));
    assert.deepEqual(roster.list().map(s => s.sessionId), ['new', 'old']);
});

test('binding resolves explicitly, silently for one, and not for many', () => {
    const one = session('one', 1), two = session('two', 2);
    assert.equal(resolveBinding([one], undefined), one);
    assert.equal(resolveBinding([one, two], 'one'), one);
    assert.equal(resolveBinding([one, two], 'gone'), undefined);
});

test('Codex thread ID is read from the direct tool-call metadata field', () => {
    assert.equal(codexThreadIdFromMeta({ threadId: 'thread-direct' }), 'thread-direct');
});

test('Codex thread ID falls back to nested turn metadata', () => {
    assert.equal(codexThreadIdFromMeta({
        'x-codex-turn-metadata': { thread_id: 'thread-nested', session_id: 'session-nested' },
    }), 'thread-nested');
    assert.equal(codexThreadIdFromMeta({
        'x-codex-turn-metadata': { session_id: 'session-nested' },
    }), 'session-nested');
});

test('direct Codex thread ID wins and malformed metadata is ignored', () => {
    assert.equal(codexThreadIdFromMeta({
        threadId: 'thread-direct',
        'x-codex-turn-metadata': { thread_id: 'thread-nested' },
    }), 'thread-direct');
    assert.equal(codexThreadIdFromMeta({ threadId: '', 'x-codex-turn-metadata': 'bad' }), undefined);
    assert.equal(codexThreadIdFromMeta(undefined), undefined);
});

test('Claude PID is derived only from supported messaging socket paths', () => {
    assert.equal(claudePidFromSocketPath('/tmp/cc-socks/22784.sock'), 22784);
    assert.equal(claudePidFromSocketPath('/private/tmp/cc-socks-501/22784.sock'), 22784);
    assert.equal(claudePidFromSocketPath('/run/user/501/cc-socks/22784.sock'), 22784);
    assert.equal(claudePidFromSocketPath('/tmp/not-claude/22784.sock'), undefined);
    assert.equal(claudePidFromSocketPath('/tmp/cc-socks/not-a-pid.sock'), undefined);
});
