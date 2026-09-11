const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeAgentLabel, claudeSessionLabel, codexSessionLabel } = require('../out/test/agent-label.js');

test('agent labels collapse whitespace and are bounded for the picker', () => {
    assert.equal(normalizeAgentLabel('  Fix\n  the login flow  '), 'Fix the login flow');
    assert.equal(normalizeAgentLabel('x'.repeat(100)), `${'x'.repeat(79)}…`);
    assert.equal(normalizeAgentLabel('   '), undefined);
});

test('Claude label comes from the matching private session registry entry', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-label-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '123.json'), JSON.stringify({ sessionId: 'right', name: 'Readable Claude task' }));
    assert.equal(claudeSessionLabel(123, 'right', home), 'Readable Claude task');
    assert.equal(claudeSessionLabel(123, 'wrong', home), undefined);
});

test('Codex label prefers the database result and rejects malformed IDs', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-label-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state_5.sqlite'), 'test');
    let calls = 0;
    const fakeSqlite = (_command, args) => {
        calls++;
        assert.equal(args[0], '-readonly');
        assert.match(args[2], /WHERE id = '01abc-def'/);
        return '  Explain MCP communication\n';
    };
    assert.equal(codexSessionLabel('01abc-def', home, fakeSqlite), 'Explain MCP communication');
    assert.equal(codexSessionLabel("bad'id", home, fakeSqlite), undefined);
    assert.equal(calls, 1);
});
