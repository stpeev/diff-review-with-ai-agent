#!/usr/bin/env node
/**
 * Diff Review MCP launcher.
 *
 * VS Code installs extensions into a directory whose name contains the version
 * (e.g. jinqishen.diff-review-0.3.0), so that path breaks on every upgrade.
 * This launcher lives at a stable path and resolves the current server at
 * runtime, in order of preference:
 *
 *   1. DIFF_REVIEW_SERVER env var (explicit override, e.g. a local dev build)
 *   2. ~/.diff-review/server-path — written by the extension on activation
 *   3. A scan of the known extension directories, picking the highest version
 *
 * Built to out/mcp-launcher.js and copied to ~/.diff-review on activation;
 * point your MCP client at that copy:
 *   claude mcp add diff-review node ~/.diff-review/mcp-launcher.js
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const STATE_DIR = path.join(os.homedir(), '.diff-review');

// Extension host roots that may hold an installed copy: stock VS Code, its
// Insiders/OSS/remote-server variants, and the popular forks.
const EXTENSION_ROOTS = [
    '.vscode', '.vscode-insiders', '.vscode-oss',
    '.vscode-server', '.vscode-server-insiders',
    '.cursor', '.cursor-server',
    '.windsurf', '.windsurf-server',
].map(dir => path.join(os.homedir(), dir, 'extensions'));

const DIR_PATTERN = /^[^.]+\.diff-review-(\d+)\.(\d+)\.(\d+)/;

function fromEnv(): string | null {
    return process.env.DIFF_REVIEW_SERVER || null;
}

function fromPointerFile(): string | null {
    try {
        const p = fs.readFileSync(path.join(STATE_DIR, 'server-path'), 'utf-8').trim();
        return p || null;
    } catch {
        return null;
    }
}

function fromExtensionDirs(): string | null {
    let best: { server: string; version: number[] } | null = null;
    for (const root of EXTENSION_ROOTS) {
        let entries: string[];
        try {
            entries = fs.readdirSync(root);
        } catch {
            continue; // root does not exist on this machine
        }
        for (const entry of entries) {
            const match = DIR_PATTERN.exec(entry);
            if (!match) continue;
            const server = path.join(root, entry, 'out', 'mcp-server.js');
            if (!fs.existsSync(server)) continue;
            const version = [Number(match[1]), Number(match[2]), Number(match[3])];
            if (!best || compareVersions(version, best.version) > 0) {
                best = { server, version };
            }
        }
    }
    return best ? best.server : null;
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

function resolveServer(): string {
    // The env var is an explicit choice, so honour it even if the file is
    // missing — failing loudly beats silently running a different build.
    const override = fromEnv();
    if (override) {
        if (!fs.existsSync(override)) {
            throw new Error(`DIFF_REVIEW_SERVER points at a missing file: ${override}`);
        }
        return override;
    }

    const pointer = fromPointerFile();
    if (pointer && fs.existsSync(pointer)) return pointer;

    const scanned = fromExtensionDirs();
    if (scanned) return scanned;

    throw new Error(
        'Cannot find the Diff Review MCP server. Install the extension in VS Code ' +
        'and launch it once, or set DIFF_REVIEW_SERVER to the path of out/mcp-server.js.'
    );
}

try {
    // The path is only known at runtime, so this has to be a real require
    // rather than an import the bundler would try to follow.
    createRequire(__filename)(resolveServer());
} catch (err: any) {
    // stdout is the MCP transport, so diagnostics must go to stderr.
    process.stderr.write(`[diff-review] ${err.message}\n`);
    process.exit(1);
}
