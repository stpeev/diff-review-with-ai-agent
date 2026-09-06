/**
 * Small filesystem helpers shared by every writer that edits a config or
 * command file it does not fully own: read a file that may not exist yet,
 * and back one up before overwriting it. Used by `mcp-consumers.ts` (MCP
 * registration) and `slash-commands.ts` (agent slash commands) — pulled out
 * here so neither module has to depend on the other for it.
 */
import * as fs from 'fs';

/** The result every writer in this codebase returns. */
export interface WriteResult {
    /** The backup taken before the write, when there was a file to back up. */
    backup?: string;
}

export function readText(file: string): string | null {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}

/**
 * Copy `file` to `<file>.diff-review-backup` before it gets overwritten,
 * clobbering any previous backup. No-op, returning `undefined`, when there is
 * nothing at `file` yet to back up.
 */
export function backup(file: string): string | undefined {
    if (!fs.existsSync(file)) return undefined;
    const dest = file + '.diff-review-backup';
    fs.copyFileSync(file, dest);
    return dest;
}
