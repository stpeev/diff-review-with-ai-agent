const test = require('node:test');
const assert = require('node:assert');
const {
    inspectVsCodeJson, writeVsCodeJson,
    inspectCodexToml, writeCodexToml,
    inspectClaudeJson, writeClaudeJson,
} = require('../out/test/mcp-consumers');

const LAUNCHER = '/Users/tester/.diff-review/mcp-launcher.js';

// --------------- VS Code / Cursor / Windsurf mcp.json ---------------

test('vscode: absent file is missing and writable', () => {
    const got = inspectVsCodeJson(null, LAUNCHER);
    assert.strictEqual(got.status, 'missing');
    assert.strictEqual(got.writable, true);
});

test('vscode: writing into an absent file produces a valid entry', () => {
    const out = writeVsCodeJson(null, LAUNCHER);
    const parsed = JSON.parse(out);
    assert.deepStrictEqual(parsed.servers['diff-review'], {
        type: 'stdio', command: 'node', args: [LAUNCHER],
    });
});

test('vscode: an entry pointing at the launcher is current', () => {
    const text = JSON.stringify({
        servers: { 'diff-review': { type: 'stdio', command: 'node', args: [LAUNCHER] } },
    });
    assert.strictEqual(inspectVsCodeJson(text, LAUNCHER).status, 'current');
});

test('vscode: an entry pointing at a versioned install is stale', () => {
    const old = '/Users/tester/.vscode/extensions/jinqishen.diff-review-0.3.0/out/mcp-server.js';
    const text = JSON.stringify({
        servers: { 'diff-review': { type: 'stdio', command: 'node', args: [old] } },
    });
    const got = inspectVsCodeJson(text, LAUNCHER);
    assert.strictEqual(got.status, 'stale');
    assert.match(got.current, /mcp-server\.js/);
});

test('vscode: a ~-relative launcher path still counts as current', () => {
    const text = JSON.stringify({
        servers: { 'diff-review': { command: 'node', args: ['~/.diff-review/mcp-launcher.js'] } },
    });
    assert.strictEqual(inspectVsCodeJson(text, LAUNCHER, '/Users/tester').status, 'current');
});

test('vscode: comments and other servers survive a write', () => {
    const text = `{
    // my servers
    "servers": {
        /* docker gateway */
        "MCP_DOCKER": { "command": "docker", "args": ["mcp", "gateway", "run"] },
    }
}`;
    const out = writeVsCodeJson(text, LAUNCHER);
    assert.match(out, /\/\/ my servers/);
    assert.match(out, /docker gateway/);
    const { parse } = require('jsonc-parser');
    const parsed = parse(out);
    assert.ok(parsed.servers.MCP_DOCKER, 'existing server preserved');
    assert.deepStrictEqual(parsed.servers['diff-review'].args, [LAUNCHER]);
});

test('vscode: unparseable content is not writable', () => {
    const got = inspectVsCodeJson('this is not json at all {{{', LAUNCHER);
    assert.strictEqual(got.writable, false);
    assert.ok(got.reason);
});

// --------------- Codex config.toml ---------------

const CODEX_STALE = `# codex config
model = "gpt-5"

[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/node_repl"
args = []

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/tester/.codex"

[mcp_servers.diff-review]
command = "node"
args = ["/Users/tester/.vscode/extensions/jinqishen.diff-review-0.3.0/out/mcp-server.js"]

[desktop]
followUpQueueMode = "queue"
`;

test('codex: a versioned path is stale', () => {
    const got = inspectCodexToml(CODEX_STALE, LAUNCHER);
    assert.strictEqual(got.status, 'stale');
    assert.strictEqual(got.writable, true);
    assert.match(got.current, /mcp-server\.js/);
});

test('codex: repairing a stale entry keeps everything around it', () => {
    const out = writeCodexToml(CODEX_STALE, LAUNCHER);
    assert.match(out, /# codex config/);
    assert.match(out, /\[mcp_servers\.node_repl\.env\]/);
    assert.match(out, /\[desktop\]/);
    assert.match(out, /followUpQueueMode = "queue"/);
    assert.ok(!out.includes('mcp-server.js'), 'versioned path is gone');
    assert.match(out, /args = \["\/Users\/tester\/\.diff-review\/mcp-launcher\.js"\]/);
    assert.strictEqual(inspectCodexToml(out, LAUNCHER).status, 'current');
});

test('codex: the replaced span swallows the entry own sub-tables', () => {
    const withEnv = CODEX_STALE.replace(
        '[desktop]',
        '[mcp_servers.diff-review.env]\nDEBUG = "1"\n\n[desktop]');
    const out = writeCodexToml(withEnv, LAUNCHER);
    assert.ok(!out.includes('DEBUG = "1"'), 'stale sub-table removed with its parent');
    assert.match(out, /\[desktop\]/);
    assert.strictEqual(inspectCodexToml(out, LAUNCHER).status, 'current');
});

test('codex: an absent table is missing, and the write appends one', () => {
    const text = 'model = "gpt-5"\n\n[desktop]\nfollowUpQueueMode = "queue"\n';
    assert.strictEqual(inspectCodexToml(text, LAUNCHER).status, 'missing');
    const out = writeCodexToml(text, LAUNCHER);
    assert.match(out, /\[desktop\]/);
    assert.strictEqual(inspectCodexToml(out, LAUNCHER).status, 'current');
});

test('codex: an absent file is missing and writable', () => {
    const got = inspectCodexToml(null, LAUNCHER);
    assert.strictEqual(got.status, 'missing');
    assert.strictEqual(got.writable, true);
    assert.strictEqual(inspectCodexToml(writeCodexToml(null, LAUNCHER), LAUNCHER).status, 'current');
});

test('codex: duplicate tables are not writable', () => {
    const got = inspectCodexToml(CODEX_STALE + '\n[mcp_servers.diff-review]\ncommand = "node"\n', LAUNCHER);
    assert.strictEqual(got.writable, false);
    assert.ok(got.reason);
});

test('codex: an inline mcp_servers table is not writable', () => {
    const got = inspectCodexToml('mcp_servers = { diff-review = { command = "node" } }\n', LAUNCHER);
    assert.strictEqual(got.writable, false);
    assert.ok(got.reason);
});

test('codex: a dotted-key entry is not writable', () => {
    const got = inspectCodexToml('mcp_servers.diff-review.command = "node"\n', LAUNCHER);
    assert.strictEqual(got.writable, false);
});

// --------------- Claude Code ~/.claude.json ---------------

test('claude: absent mcpServers is missing, and the write creates it', () => {
    const text = JSON.stringify({ projects: {}, numStartups: 12 });
    assert.strictEqual(inspectClaudeJson(text, LAUNCHER).status, 'missing');
    const parsed = JSON.parse(writeClaudeJson(text, LAUNCHER));
    assert.strictEqual(parsed.numStartups, 12, 'unrelated keys survive');
    assert.deepStrictEqual(parsed.mcpServers['diff-review'],
        { type: 'stdio', command: 'node', args: [LAUNCHER], timeout: 60000 });
});

test('claude: a launcher entry is current', () => {
    const text = JSON.stringify({ mcpServers: { 'diff-review': { command: 'node', args: [LAUNCHER], timeout: 60000 } } });
    assert.strictEqual(inspectClaudeJson(text, LAUNCHER).status, 'current');
});

test('claude: a non-object root is not writable', () => {
    assert.strictEqual(inspectClaudeJson('[1,2,3]', LAUNCHER).writable, false);
});

// --------------- VS Code profiles ---------------

const { parseProfiles } = require('../out/test/mcp-consumers');

test('profiles: only profiles with their own mcp config are listed', () => {
    const storage = JSON.stringify({
        userDataProfiles: [
            // Shares the default profile's mcp.json — a row here would write a
            // file VS Code never reads.
            { location: 'builtin/agents', name: 'Agents', useDefaultFlags: { mcp: true } },
            { location: 'abc123', name: 'Work' },
            { location: 'def456', name: 'Client', useDefaultFlags: { settings: true } },
        ],
    });
    assert.deepStrictEqual(parseProfiles(storage), [
        { location: 'abc123', name: 'Work' },
        { location: 'def456', name: 'Client' },
    ]);
});

test('profiles: nested locations are kept whole', () => {
    const storage = JSON.stringify({ userDataProfiles: [{ location: 'builtin/agents', name: 'Agents' }] });
    assert.deepStrictEqual(parseProfiles(storage), [{ location: 'builtin/agents', name: 'Agents' }]);
});

test('profiles: orphaned directories are not profiles', () => {
    // A directory under profiles/ that storage.json does not list is stale
    // state, not a profile — VS Code ignores it and so do we.
    assert.deepStrictEqual(parseProfiles(JSON.stringify({ userDataProfiles: [] })), []);
});

test('profiles: unreadable or absent storage.json yields no profiles', () => {
    assert.deepStrictEqual(parseProfiles(null), []);
    assert.deepStrictEqual(parseProfiles('{{{ not json'), []);
    assert.deepStrictEqual(parseProfiles(JSON.stringify({})), []);
});
