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

// --------------- Discovery and status ---------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverSlashCommands } = require('../out/slash-commands');

function tmpHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-slash-'));
}

test('discoverSlashCommands: no rows on an empty home', () => {
    const targets = discoverSlashCommands({ home: tmpHome(), platform: 'linux' });
    assert.strictEqual(targets.length, 0);
});

test('discoverSlashCommands: Claude Code row appears once ~/.claude/commands exists', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
    const targets = discoverSlashCommands({ home, platform: 'linux' });
    const claude = targets.find(t => t.id === 'claude');
    assert.ok(claude, 'expected a claude row');
    assert.strictEqual(claude.kind, 'claude-md');
    assert.strictEqual(claude.files.length, 2);
    assert.deepStrictEqual(claude.files.map(f => f.command).sort(), ['address', 'perform']);
    assert.ok(claude.files.every(f => f.status === 'missing' && f.writable === true));
    assert.strictEqual(claude.status, 'missing');
});

test('discoverSlashCommands: Codex CLI honours codexHome override', () => {
    const home = tmpHome();
    const codexHome = path.join(home, 'custom-codex');
    fs.mkdirSync(path.join(codexHome, 'prompts'), { recursive: true });
    const targets = discoverSlashCommands({ home, platform: 'linux', codexHome });
    const codex = targets.find(t => t.id === 'codex');
    assert.ok(codex);
    assert.strictEqual(codex.dirPath, path.join(codexHome, 'prompts'));
});

test('discoverSlashCommands: Gemini CLI row uses .toml filenames', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.gemini', 'commands'), { recursive: true });
    const targets = discoverSlashCommands({ home, platform: 'linux' });
    const gemini = targets.find(t => t.id === 'gemini');
    assert.ok(gemini);
    assert.ok(gemini.files.every(f => f.filePath.endsWith('.toml')));
});

test('discoverSlashCommands: a fully current file is status current and writable', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), require('../out/slash-commands').renderBody('claude-md', 'perform'));
    const targets = discoverSlashCommands({ home, platform: 'linux' });
    const claude = targets.find(t => t.id === 'claude');
    const perform = claude.files.find(f => f.command === 'perform');
    assert.strictEqual(perform.status, 'current');
    assert.strictEqual(perform.writable, true);
});

test('discoverSlashCommands: a stale file with our marker is writable', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const { MARKER } = require('../out/slash-commands');
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), `${MARKER.perform}\nan older version\n`);
    const targets = discoverSlashCommands({ home, platform: 'linux' });
    const perform = targets.find(t => t.id === 'claude').files.find(f => f.command === 'perform');
    assert.strictEqual(perform.status, 'stale');
    assert.strictEqual(perform.writable, true);
});

test('discoverSlashCommands: a stale file without our marker is not writable', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), 'a hand-written command, not ours\n');
    const targets = discoverSlashCommands({ home, platform: 'linux' });
    const perform = targets.find(t => t.id === 'claude').files.find(f => f.command === 'perform');
    assert.strictEqual(perform.status, 'stale');
    assert.strictEqual(perform.writable, false);
    assert.match(perform.reason, /not written by Diff Review/);
});

test('discoverSlashCommands: row status is the worse of its two files (missing wins)', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), require('../out/slash-commands').renderBody('claude-md', 'perform'));
    // address-diff-review.md left missing.
    const claude = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    assert.strictEqual(claude.status, 'missing');
});

test('discoverSlashCommands: row status is stale when one file is stale and the other current', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const sc = require('../out/slash-commands');
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), sc.renderBody('claude-md', 'perform'));
    fs.writeFileSync(path.join(dir, 'address-diff-review.md'), `${sc.MARKER.address}\nold\n`);
    const claude = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    assert.strictEqual(claude.status, 'stale');
});

test('discoverSlashCommands: row status is current only when both files are', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const sc = require('../out/slash-commands');
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), sc.renderBody('claude-md', 'perform'));
    fs.writeFileSync(path.join(dir, 'address-diff-review.md'), sc.renderBody('claude-md', 'address'));
    const claude = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    assert.strictEqual(claude.status, 'current');
});

test('discoverSlashCommands: row writable is true if at least one file is writable', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), 'hand-written\n');
    const claude = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    assert.strictEqual(claude.writable, true); // address-diff-review.md is still missing => writable
});

test('discoverSlashCommands: VS Code family row appears when the app root exists', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Code', 'User'), { recursive: true });
    const targets = discoverSlashCommands({ home, platform: 'darwin' });
    const vscode = targets.find(t => t.id === 'vscode');
    assert.ok(vscode);
    assert.strictEqual(vscode.kind, 'vscode-prompt');
    assert.strictEqual(
        vscode.dirPath,
        path.join(home, 'Library', 'Application Support', 'Code', 'User', 'prompts'),
    );
    assert.ok(vscode.files.every(f => f.filePath.endsWith('.prompt.md')));
});

test('discoverSlashCommands: VS Code family excludes Cursor and Windsurf', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Cursor', 'User'), { recursive: true });
    const targets = discoverSlashCommands({ home, platform: 'darwin' });
    assert.strictEqual(targets.find(t => t.id === 'cursor'), undefined);
});

test('discoverSlashCommands: a nested profile location builds the correct prompts path', () => {
    const home = tmpHome();
    const root = path.join(home, 'Library', 'Application Support', 'Code', 'User');
    fs.mkdirSync(path.join(root, 'globalStorage'), { recursive: true });
    fs.mkdirSync(path.join(root, 'profiles', 'builtin', 'agents'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'globalStorage', 'storage.json'),
        JSON.stringify({ userDataProfiles: [{ location: 'builtin/agents', name: 'Agents' }] }),
    );
    const targets = discoverSlashCommands({ home, platform: 'darwin' });
    const profile = targets.find(t => t.id === 'vscode:profile:builtin/agents');
    assert.ok(profile, 'expected a nested profile row');
    assert.strictEqual(profile.label, 'VS Code — profile "Agents"');
    assert.strictEqual(
        profile.dirPath,
        path.join(root, 'profiles', 'builtin', 'agents', 'prompts'),
    );
});

test('discoverSlashCommands: a profile directory that does not exist on disk produces no row', () => {
    const home = tmpHome();
    const root = path.join(home, 'Library', 'Application Support', 'Code', 'User');
    fs.mkdirSync(path.join(root, 'globalStorage'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'globalStorage', 'storage.json'),
        JSON.stringify({ userDataProfiles: [{ location: 'ghost', name: 'Ghost' }] }),
    );
    const targets = discoverSlashCommands({ home, platform: 'darwin' });
    assert.strictEqual(targets.find(t => t.id === 'vscode:profile:ghost'), undefined);
});

// --------------- Clipboard rendering and writers ---------------

const { renderClipboard, install } = require('../out/slash-commands');

test('renderClipboard: includes the body and a save-this-to line naming the path', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const targets = discoverSlashCommands({ home, platform: 'linux' });
    const claude = targets.find(t => t.id === 'claude');
    const clip = renderClipboard(claude, 'perform');
    assert.ok(clip.includes(require('../out/slash-commands').MARKER.perform));
    assert.match(clip, /Save this to: .*perform-diff-review\.md/);
});

test('install: writes missing files and returns one result per file written', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const target = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    const outcome = install(target);
    assert.strictEqual(outcome.written.length, 2);
    assert.strictEqual(outcome.errors.length, 0);
    assert.strictEqual(
        fs.readFileSync(path.join(dir, 'perform-diff-review.md'), 'utf-8'),
        require('../out/slash-commands').renderBody('claude-md', 'perform'),
    );
});

test('install: skips a file that is already current', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const sc = require('../out/slash-commands');
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), sc.renderBody('claude-md', 'perform'));
    const target = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    const outcome = install(target);
    assert.strictEqual(outcome.written.length, 1); // only address-diff-review.md
    assert.strictEqual(outcome.written[0].command, 'address');
});

test('install: backs up a stale-with-marker file before overwriting it', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const sc = require('../out/slash-commands');
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), `${sc.MARKER.perform}\nold body\n`);
    const target = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    const outcome = install(target);
    const result = outcome.written.find(w => w.command === 'perform');
    assert.ok(result.backup);
    assert.strictEqual(fs.readFileSync(result.backup, 'utf-8'), `${sc.MARKER.perform}\nold body\n`);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'perform-diff-review.md'), 'utf-8'), sc.renderBody('claude-md', 'perform'));
});

test('install: never touches a stale-without-marker file', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'perform-diff-review.md'), 'hand written, not ours\n');
    const target = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    const outcome = install(target);
    assert.strictEqual(outcome.written.find(w => w.command === 'perform'), undefined);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'perform-diff-review.md'), 'utf-8'), 'hand written, not ours\n');
});

test('install: a write failure on one file is reported without blocking the other', () => {
    const home = tmpHome();
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    const target = discoverSlashCommands({ home, platform: 'linux' }).find(t => t.id === 'claude');
    // Force perform-diff-review.md's write to fail: pre-create it as a
    // directory, which writeFileSync cannot write into.
    fs.mkdirSync(path.join(dir, 'perform-diff-review.md'));
    const outcome = install(target);
    assert.strictEqual(outcome.errors.length, 1);
    assert.strictEqual(outcome.errors[0].command, 'perform');
    assert.strictEqual(outcome.written.length, 1);
    assert.strictEqual(outcome.written[0].command, 'address');
});

test('install: creates the parent directory when it does not exist yet', () => {
    const home = tmpHome();
    // ~/.claude exists but .../commands does not -- discoverSlashCommands
    // requires the commands dir itself to exist to produce a row, so build a
    // target by hand for this case instead (a VS Code profile's prompts/
    // subdirectory is exactly this situation in real use).
    const dir = path.join(home, '.claude', 'commands');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // parent only
    const target = {
        id: 'claude', label: 'Claude Code', kind: 'claude-md', dirPath: dir,
        files: [
            { command: 'perform', filePath: path.join(dir, 'perform-diff-review.md'), invocation: '/perform-diff-review', status: 'missing', writable: true },
            { command: 'address', filePath: path.join(dir, 'address-diff-review.md'), invocation: '/address-diff-review', status: 'missing', writable: true },
        ],
        status: 'missing', writable: true,
    };
    const outcome = install(target);
    assert.strictEqual(outcome.errors.length, 0);
    assert.strictEqual(outcome.written.length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'perform-diff-review.md')));
});
