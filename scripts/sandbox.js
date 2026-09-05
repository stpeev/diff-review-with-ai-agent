#!/usr/bin/env node
/**
 * Launch a throwaway VS Code instance with this repo loaded as the extension
 * under development.
 *
 *   node scripts/sandbox.js                 launch (reusing any existing sandbox)
 *   node scripts/sandbox.js --clean         wipe the sandbox first
 *   node scripts/sandbox.js --no-pointer    delete ~/.diff-review/server-path so the
 *                                           launcher falls back to its directory scan
 *   node scripts/sandbox.js --env           set DIFF_REVIEW_SERVER to this repo's build
 *   node scripts/sandbox.js --dir <path>    put the sandbox somewhere other than tmp
 *
 * The point of the fake HOME: --user-data-dir and --extensions-dir isolate the
 * editor, but the extension writes its pointer file to ~/.diff-review, which
 * lives outside both. Without the override a test run clobbers the pointer file
 * your real install and MCP clients share.
 *
 * Assumes `npm run build` has already run (the npm script chains it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);

function flagValue(name) {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
}

const sandbox = path.resolve(flagValue('--dir') || path.join(os.tmpdir(), 'diff-review-sandbox'));
const userDataDir = path.join(sandbox, 'data');
// Must sit at <fake home>/.vscode/extensions: that is exactly where the
// launcher's directory scan looks, so this keeps the scan fallback testable
// rather than silently dead.
const extensionsDir = path.join(sandbox, '.vscode', 'extensions');
const stateDir = path.join(sandbox, '.diff-review');

if (!fs.existsSync(path.join(root, 'out', 'extension.js'))) {
    process.stderr.write('[sandbox] out/extension.js is missing — run `npm run build` first.\n');
    process.exit(1);
}

if (argv.includes('--clean')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
    console.log(`[sandbox] wiped ${sandbox}`);
}

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(extensionsDir, { recursive: true });

if (argv.includes('--no-pointer')) {
    fs.rmSync(path.join(stateDir, 'server-path'), { force: true });
    console.log('[sandbox] removed the pointer file — the launcher will fall back to its scan');
}

const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox };
if (argv.includes('--env')) {
    env.DIFF_REVIEW_SERVER = path.join(root, 'out', 'mcp-server.js');
    console.log(`[sandbox] DIFF_REVIEW_SERVER=${env.DIFF_REVIEW_SERVER}`);
}

const args = [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${root}`,
    '--new-window',
    path.join(root, 'examples'),
];

console.log(`[sandbox] HOME=${sandbox}`);
console.log('[sandbox] launching — run "Diff Review: Show MCP Server Info" from the palette');

// Detached so the sandbox outlives this process; `code` on macOS/Linux is a
// shell wrapper that exits immediately anyway.
const child = spawn('code', args, {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: true,
    shell: process.platform === 'win32',
});

child.on('error', err => {
    process.stderr.write(
        err.code === 'ENOENT'
            ? '[sandbox] `code` is not on PATH — run "Shell Command: Install \'code\' command in PATH" from VS Code.\n'
            : `[sandbox] ${err.message}\n`
    );
    process.exit(1);
});

child.unref();
