#!/usr/bin/env node
/**
 * Local deploy helper. Two modes:
 *
 *   node scripts/local-deploy.js          full  — package a .vsix and install it via
 *                                                 the `code` CLI (after a version bump)
 *   node scripts/local-deploy.js --fast   fast  — copy the freshly built out/*.js over
 *                                                 an already-installed extension of the
 *                                                 same version, skipping packaging
 *
 * Both assume `npm run build` has already run (the npm scripts chain it).
 * Either way, reload the VS Code window afterwards to pick up the new build.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const fast = process.argv.includes('--fast');

// Same extension host roots the MCP launcher scans, so a fast deploy reaches
// whichever editor the launcher would resolve.
const EXTENSION_ROOTS = [
    '.vscode', '.vscode-insiders', '.vscode-oss',
    '.vscode-server', '.vscode-server-insiders',
    '.cursor', '.cursor-server',
    '.windsurf', '.windsurf-server',
].map(dir => path.join(os.homedir(), dir, 'extensions'));

const BUILT_FILES = ['extension.js', 'mcp-server.js', 'mcp-launcher.js'];

function run(cmd, args) {
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

function installedDirs() {
    // Match any publisher so a locally repackaged build is found too.
    const suffix = `.diff-review-${pkg.version}`;
    const found = [];
    for (const extRoot of EXTENSION_ROOTS) {
        let entries;
        try {
            entries = fs.readdirSync(extRoot);
        } catch {
            continue; // root does not exist on this machine
        }
        for (const entry of entries) {
            if (entry.endsWith(suffix)) found.push(path.join(extRoot, entry));
        }
    }
    return found;
}

function deployFast() {
    for (const file of BUILT_FILES) {
        if (!fs.existsSync(path.join(root, 'out', file))) {
            throw new Error(`out/${file} is missing — run \`npm run build\` first.`);
        }
    }

    const targets = installedDirs();
    if (targets.length === 0) {
        throw new Error(
            `No installed extension found for version ${pkg.version}. ` +
            'Run `npm run deploy` once to install it, then use the fast path for later edits.'
        );
    }

    for (const target of targets) {
        for (const file of BUILT_FILES) {
            fs.copyFileSync(path.join(root, 'out', file), path.join(target, 'out', file));
        }
        console.log(`[deploy] updated ${target}`);
    }
}

function deployFull() {
    // Reuse the package script so the vsce flags (and its prompt answer) stay in one place.
    run('npm', ['run', 'package']);
    const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
    run('code', ['--install-extension', vsix, '--force']);
    console.log(`[deploy] installed ${path.basename(vsix)}`);
}

try {
    if (fast) deployFast();
    else deployFull();
    console.log('[deploy] done — reload the VS Code window (Developer: Reload Window).');
} catch (err) {
    process.stderr.write(`[deploy] ${err.message}\n`);
    process.exit(1);
}
