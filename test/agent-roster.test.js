const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRoster, resolveBinding } = require('../out/test/agent-roster.js');
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
