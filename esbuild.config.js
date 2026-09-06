#!/usr/bin/env node
/**
 * Build configuration for every bundle this repo produces.
 *
 * esbuild has no config-file convention of its own — it takes CLI flags or a
 * script calling its JS API. This is that script, named for what it is. Run it
 * directly, with an optional list of target or group names:
 *
 *   node esbuild.config.js                  build everything
 *   node esbuild.config.js ext consumers    build just those targets
 *   node esbuild.config.js test              build a named group (see `groups`)
 *
 * Keeping the options here rather than in package.json scripts means shared
 * settings are stated once. `mainFields` especially: jsonc-parser's CommonJS
 * entry does a dynamic require esbuild cannot follow, so without the ESM entry
 * the extension bundle resolves it at runtime — and `vsce package
 * --no-dependencies` ships no node_modules for it to find. That breaks only in
 * a packaged install, never in the dev host, so it must not live somewhere a
 * future edit can quietly drop it.
 */
const esbuild = require('esbuild');

const shared = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    mainFields: ['module', 'main'],
    logLevel: 'info',
};

// Every pure module below (no `vscode` import in its own graph) is built on
// its own, standalone from `ext`, so `node --test` can require it outside a
// VS Code host — see the note on `standalone` in `groups` below for why that
// duplicates work `ext` already does internally.
const targets = {
    // The extension host supplies `vscode` at runtime; bundling it would fail.
    ext: { ...shared, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', external: ['vscode'] },
    mcp: { ...shared, entryPoints: ['src/mcp-server.ts'], outfile: 'out/mcp-server.js', target: 'node18' },
    launcher: { ...shared, entryPoints: ['src/mcp-launcher.ts'], outfile: 'out/mcp-launcher.js', target: 'node18' },
    consumers: { ...shared, entryPoints: ['src/mcp-consumers.ts'], outfile: 'out/mcp-consumers.js', target: 'node18' },
    'ipc-discovery': { ...shared, entryPoints: ['src/ipc-discovery.ts'], outfile: 'out/ipc-discovery.js', target: 'node18' },
    'scope-id': { ...shared, entryPoints: ['src/scope-id.ts'], outfile: 'out/scope-id.js', target: 'node18' },
    'comment-store': { ...shared, entryPoints: ['src/comment-store.ts'], outfile: 'out/comment-store.js', target: 'node18' },
    'path-util': { ...shared, entryPoints: ['src/path-util.ts'], outfile: 'out/path-util.js', target: 'node18' },
    'file-write': { ...shared, entryPoints: ['src/file-write.ts'], outfile: 'out/file-write.js', target: 'node18' },
    'vscode-profiles': { ...shared, entryPoints: ['src/vscode-profiles.ts'], outfile: 'out/vscode-profiles.js', target: 'node18' },
    'slash-commands': { ...shared, entryPoints: ['src/slash-commands.ts'], outfile: 'out/slash-commands.js', target: 'node18' },
};

/**
 * Named groups of targets, expanded by the CLI below. package.json's scripts
 * reference the group name rather than enumerating members, so adding a new
 * pure module for `node --test` to require touches only this file — not
 * every `npm test` invocation that lists targets by hand.
 */
const groups = {
    // What actually ships in the packaged extension.
    ship: ['ext', 'mcp', 'launcher'],
    // Not shipped — each of these is already *inside* out/extension.js via
    // extension.ts's own imports, but that bundle also does
    // `import * as vscode from 'vscode'` at its top — with `vscode`
    // external, requiring it outside the extension host throws immediately,
    // before a test could reach any pure function in it. Building each
    // module alone, with no `external` and no vscode import in its own
    // graph, is what lets a plain `node --test` require it.
    standalone: [
        'consumers', 'file-write', 'vscode-profiles', 'slash-commands',
        'ipc-discovery', 'scope-id', 'comment-store', 'path-util',
    ],
};

module.exports = { shared, targets, groups };

if (require.main === module) {
    const names = process.argv.slice(2);
    const expanded = names.length > 0
        ? names.flatMap(name => groups[name] ?? [name])
        : Object.keys(targets);

    const unknown = expanded.filter(name => !(name in targets));
    if (unknown.length > 0) {
        process.stderr.write(`[build] unknown target(s): ${unknown.join(', ')}\n`);
        process.stderr.write(`[build] known targets: ${Object.keys(targets).join(', ')}\n`);
        process.stderr.write(`[build] known groups: ${Object.keys(groups).join(', ')}\n`);
        process.exit(1);
    }

    Promise.all(expanded.map(name => esbuild.build(targets[name]))).catch(() => process.exit(1));
}
