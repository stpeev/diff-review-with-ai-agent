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

// The `standalone` targets below (no `vscode` import in their own graph) are
// each of these pure modules built alone, so `node --test` can require one
// outside a VS Code host — see the note on `standalone` in `groups` for why
// that duplicates work `ext` already does internally. They build into
// `out/test/`, not `out/` directly: `.vscodeignore` excludes that whole
// subdirectory, so this — unlike `out/`'s top level — is the one place under
// `out/` that genuinely never ships. Each one is already *inside*
// out/extension.js via extension.ts's own imports, so shipping the loose
// standalone copy too would just be dead weight in the packaged .vsix.
const targets = {
    // The extension host supplies `vscode` at runtime; bundling it would fail.
    ext: { ...shared, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', external: ['vscode'] },
    mcp: { ...shared, entryPoints: ['src/mcp-server.ts'], outfile: 'out/mcp-server.js', target: 'node18' },
    launcher: { ...shared, entryPoints: ['src/mcp-launcher.ts'], outfile: 'out/mcp-launcher.js', target: 'node18' },
    consumers: { ...shared, entryPoints: ['src/mcp-consumers.ts'], outfile: 'out/test/mcp-consumers.js', target: 'node18' },
    'ipc-discovery': { ...shared, entryPoints: ['src/ipc-discovery.ts'], outfile: 'out/test/ipc-discovery.js', target: 'node18' },
    'scope-id': { ...shared, entryPoints: ['src/scope-id.ts'], outfile: 'out/test/scope-id.js', target: 'node18' },
    'comment-store': { ...shared, entryPoints: ['src/comment-store.ts'], outfile: 'out/test/comment-store.js', target: 'node18' },
    'path-util': { ...shared, entryPoints: ['src/path-util.ts'], outfile: 'out/test/path-util.js', target: 'node18' },
    'file-write': { ...shared, entryPoints: ['src/file-write.ts'], outfile: 'out/test/file-write.js', target: 'node18' },
    'vscode-profiles': { ...shared, entryPoints: ['src/vscode-profiles.ts'], outfile: 'out/test/vscode-profiles.js', target: 'node18' },
    'slash-commands': { ...shared, entryPoints: ['src/slash-commands.ts'], outfile: 'out/test/slash-commands.js', target: 'node18' },
    'review-policy': { ...shared, entryPoints: ['src/review-policy.ts'], outfile: 'out/test/review-policy.js', target: 'node18' },
    'git-scope': { ...shared, entryPoints: ['src/git-scope.ts'], outfile: 'out/test/git-scope.js', target: 'node18' },
};

/**
 * Named groups of targets, expanded by the CLI below. package.json's scripts
 * reference the group name rather than enumerating members, so adding a new
 * pure module for `node --test` to require touches only this file — not
 * every `npm test` invocation that lists targets by hand.
 */
const groups = {
    // The 3 bundles the packaged extension actually loads at runtime.
    ship: ['ext', 'mcp', 'launcher'],
    // Every pure module built alone (see the comment on `targets` above) so
    // `node --test` can require it directly.
    standalone: [
        'consumers', 'file-write', 'vscode-profiles', 'slash-commands',
        'ipc-discovery', 'scope-id', 'comment-store', 'path-util', 'git-scope',
        'review-policy',
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
