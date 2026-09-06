const test = require('node:test');
const assert = require('node:assert');
const { renderBody, MARKER, INVOCATION } = require('../out/slash-commands');

test('INVOCATION: the two commands', () => {
    assert.strictEqual(INVOCATION.perform, '/perform-diff-review');
    assert.strictEqual(INVOCATION.address, '/address-diff-review');
});

test('renderBody: claude-md carries description and allowed-tools frontmatter', () => {
    const body = renderBody('claude-md', 'perform');
    assert.match(body, /^---\n/);
    assert.match(body, /\ndescription: .+\n/);
    assert.match(body, /\nallowed-tools: .+\n/);
    assert.match(body, /\n---\n\n/);
});

test('renderBody: codex-md has no frontmatter at all', () => {
    const body = renderBody('codex-md', 'perform');
    assert.ok(!body.startsWith('---'));
    assert.ok(body.startsWith(MARKER.perform));
});

test('renderBody: vscode-prompt sets mode: agent', () => {
    const body = renderBody('vscode-prompt', 'address');
    assert.match(body, /\nmode: agent\n/);
});

test('renderBody: gemini-toml has a description key and a triple-quoted prompt', () => {
    const body = renderBody('gemini-toml', 'address');
    assert.match(body, /^description = ".+"\n/);
    assert.match(body, /\nprompt = """\n/);
    assert.match(body, /\n"""\n$/);
});

test('renderBody: every wrapper carries the marker for its command', () => {
    for (const kind of ['claude-md', 'codex-md', 'gemini-toml', 'vscode-prompt']) {
        assert.ok(renderBody(kind, 'perform').includes(MARKER.perform), `${kind} missing perform marker`);
        assert.ok(renderBody(kind, 'address').includes(MARKER.address), `${kind} missing address marker`);
    }
});

test('renderBody: the perform and address markers differ', () => {
    assert.notStrictEqual(MARKER.perform, MARKER.address);
});

function bodyAfterMarker(rendered, marker, kind) {
    const idx = rendered.indexOf(marker);
    let body = rendered.slice(idx);
    if (kind === 'gemini-toml') {
        // Undo the TOML basic multi-line string wrapping: strip the closing
        // delimiter, then reverse the backslash-escaping applied on the way
        // in. Both are real, necessary differences for this one wrapper --
        // not a mismatch in the instructional content itself.
        body = body.replace(/"""\n$/, '');
        body = body.replace(/\\"\\"\\"/g, '"""').replace(/\\\\/g, '\\');
    }
    return body;
}

test('renderBody: the instructional Markdown is identical across all four wrappers', () => {
    for (const command of ['perform', 'address']) {
        const claude = bodyAfterMarker(renderBody('claude-md', command), MARKER[command], 'claude-md');
        const codex = bodyAfterMarker(renderBody('codex-md', command), MARKER[command], 'codex-md');
        const vscode = bodyAfterMarker(renderBody('vscode-prompt', command), MARKER[command], 'vscode-prompt');
        const gemini = bodyAfterMarker(renderBody('gemini-toml', command), MARKER[command], 'gemini-toml');
        assert.strictEqual(claude, codex, 'claude vs codex body mismatch');
        assert.strictEqual(claude, vscode, 'claude vs vscode body mismatch');
        assert.strictEqual(claude, gemini, 'claude vs gemini body mismatch');
    }
});

test('renderBody: perform instructs never to edit code or commit', () => {
    const body = renderBody('claude-md', 'perform');
    assert.match(body, /[Nn]ever edit code/);
    assert.match(body, /[Nn]ever commit/);
});

test('renderBody: address instructs never to commit', () => {
    const body = renderBody('claude-md', 'address');
    assert.match(body, /[Nn]ever commit/);
});

test('renderBody: gemini-toml escapes a literal """ in the body', () => {
    // The authored bodies never contain a literal triple-quote today; this
    // guards the escaping logic itself rather than current content.
    const { __escapeTomlMultilineStringForTest } = require('../out/slash-commands');
    const escaped = __escapeTomlMultilineStringForTest('before """ after \\ done');
    assert.ok(!escaped.includes('"""'));
    assert.match(escaped, /\\\\/);
});
