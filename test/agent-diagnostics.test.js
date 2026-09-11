const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnosticEnvironment, sanitizeDiagnostic } = require('../out/test/agent-diagnostics.js');

test('diagnosticEnvironment keeps relevant identity context and redacts secrets', () => {
    assert.deepEqual(diagnosticEnvironment({
        CODEX_THREAD_ID: 'thread-1',
        CODEX_API_KEY: 'secret',
        VSCODE_CWD: '/work',
        PATH: '/bin',
    }), {
        CODEX_API_KEY: '<redacted>',
        CODEX_THREAD_ID: 'thread-1',
        VSCODE_CWD: '/work',
    });
});

test('sanitizeDiagnostic recursively redacts secret-bearing fields', () => {
    assert.deepEqual(sanitizeDiagnostic({
        threadId: 'thread-1',
        nested: { authToken: 'secret', turnId: 'turn-1' },
    }), {
        threadId: 'thread-1',
        nested: { authToken: '<redacted>', turnId: 'turn-1' },
    });
});
