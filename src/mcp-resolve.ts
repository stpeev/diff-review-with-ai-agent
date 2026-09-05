/**
 * Shared MCP server resolution.
 *
 * The launcher lives at a stable path and has to find the current server at
 * runtime; the extension's "Show MCP Server Info" command has to report what
 * that launcher *would* find. Both use the rules here so the report can never
 * drift from the behaviour it describes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const STATE_DIR = path.join(os.homedir(), '.diff-review');
export const POINTER_FILE = path.join(STATE_DIR, 'server-path');
export const LAUNCHER_FILE = path.join(STATE_DIR, 'mcp-launcher.js');

// Extension host roots that may hold an installed copy: stock VS Code, its
// Insiders/OSS/remote-server variants, and the popular forks.
const EXTENSION_ROOTS = [
    '.vscode', '.vscode-insiders', '.vscode-oss',
    '.vscode-server', '.vscode-server-insiders',
    '.cursor', '.cursor-server',
    '.windsurf', '.windsurf-server',
].map(dir => path.join(os.homedir(), dir, 'extensions'));

const DIR_PATTERN = /^[^.]+\.diff-review-(\d+)\.(\d+)\.(\d+)/;

/** Which rule produced a resolved path. */
export type ResolutionSource = 'env' | 'pointer' | 'scan';

export interface Resolution {
    path: string;
    source: ResolutionSource;
    /** Version parsed from the directory name, when the scan found it. */
    version?: string;
}

export function fromEnv(): string | null {
    return process.env.DIFF_REVIEW_SERVER || null;
}

export function fromPointerFile(): string | null {
    try {
        const p = fs.readFileSync(POINTER_FILE, 'utf-8').trim();
        return p || null;
    } catch {
        return null;
    }
}

export function fromExtensionDirs(): Resolution | null {
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
    return best ? { path: best.server, source: 'scan', version: best.version.join('.') } : null;
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * Resolve the server a client would run, in order of preference. Throws with a
 * user-facing message when nothing is installed.
 */
export function resolveServer(): Resolution {
    // The env var is an explicit choice, so honour it even if the file is
    // missing — failing loudly beats silently running a different build.
    const override = fromEnv();
    if (override) {
        if (!fs.existsSync(override)) {
            throw new Error(`DIFF_REVIEW_SERVER points at a missing file: ${override}`);
        }
        return { path: override, source: 'env' };
    }

    const pointer = fromPointerFile();
    if (pointer && fs.existsSync(pointer)) return { path: pointer, source: 'pointer' };

    const scanned = fromExtensionDirs();
    if (scanned) return scanned;

    throw new Error(
        'Cannot find the Diff Review MCP server. Install the extension in VS Code ' +
        'and launch it once, or set DIFF_REVIEW_SERVER to the path of out/mcp-server.js.'
    );
}
