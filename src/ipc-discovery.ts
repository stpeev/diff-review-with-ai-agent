/**
 * Per-window IPC port discovery (F1).
 *
 * The old scheme wrote one global `<tmpdir>/diff-review-port` file that every
 * window overwrote, so the last window to activate silently received all MCP
 * traffic. Each window now writes its own descriptor into
 * `<tmpdir>/diff-review/<hash>.json`; `mcp-server.ts` reads the directory and
 * picks the descriptor whose workspace roots actually contain the caller's
 * cwd, instead of trusting whichever window wrote most recently.
 *
 * This module is pure — no fs, no network. `extension.ts` and `mcp-server.ts`
 * do the I/O (write/read descriptor files, ping candidates) and hand the
 * results here to resolve.
 */
import * as crypto from 'crypto';
import * as path from 'path';
import { deepestAncestor } from './path-util';

export const DESCRIPTOR_DIRNAME = 'diff-review';

export interface Descriptor {
    port: number;
    /** Workspace folder paths open in this window. Empty when no folder is open. */
    workspaceRoots: string[];
    pid: number;
    startedAt: string;
}

export function descriptorDir(tmpDir: string): string {
    return path.join(tmpDir, DESCRIPTOR_DIRNAME);
}

/** Stable per-window filename: keyed by the sorted root set, or by pid when there is none. */
export function descriptorFileName(workspaceRoots: string[], pid: number): string {
    const key = workspaceRoots.length > 0 ? [...workspaceRoots].sort().join('|') : `no-workspace.${pid}`;
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    return `${hash}.json`;
}

export function descriptorPath(tmpDir: string, workspaceRoots: string[], pid: number): string {
    return path.join(descriptorDir(tmpDir), descriptorFileName(workspaceRoots, pid));
}

interface RootMatch { descriptor: Descriptor; root: string; }

/** The descriptor+root pair whose root is the deepest ancestor of `cwd`. */
export function deepestMatch(descriptors: Descriptor[], cwd: string): RootMatch | undefined {
    const pairs: RootMatch[] = [];
    for (const descriptor of descriptors) {
        for (const root of descriptor.workspaceRoots) pairs.push({ descriptor, root });
    }
    return deepestAncestor(pairs, p => p.root, cwd);
}

export type ResolveSource = 'flag' | 'cwd-match' | 'sole-live';

export interface ResolveResult {
    port: number;
    /** The single root that justified this resolution, for the server-side mismatch check. */
    matchedRoot: string | null;
    source: ResolveSource;
}

export class NoServerError extends Error {
    constructor() {
        super('Cannot find a running Diff Review IPC server. Is the VS Code extension active?');
        this.name = 'NoServerError';
    }
}

export class AmbiguousPortError extends Error {
    constructor(public readonly candidates: Descriptor[]) {
        super(
            'Multiple Diff Review windows are running and none matches the current directory:\n' +
            candidates.map(c => `  port ${c.port} — ${c.workspaceRoots.join(', ') || '(no workspace folder)'}`).join('\n') +
            '\nPass --port <port> to pick one.'
        );
        this.name = 'AmbiguousPortError';
    }
}

/**
 * Resolve which port to talk to. `descriptors` must already be filtered to
 * ones that answered a liveness ping — this function does no I/O and trusts
 * its input. Order: explicit flag, then the descriptor whose root is the
 * deepest ancestor of `cwd`, then the sole remaining live descriptor, else
 * fail with the full candidate list rather than guessing.
 */
export function resolvePort(descriptors: Descriptor[], opts: { portFlag?: number; cwd: string }): ResolveResult {
    if (opts.portFlag !== undefined) {
        return { port: opts.portFlag, matchedRoot: null, source: 'flag' };
    }
    if (descriptors.length === 0) {
        throw new NoServerError();
    }
    const match = deepestMatch(descriptors, opts.cwd);
    if (match) {
        return { port: match.descriptor.port, matchedRoot: match.root, source: 'cwd-match' };
    }
    if (descriptors.length === 1) {
        const only = descriptors[0];
        return { port: only.port, matchedRoot: only.workspaceRoots[0] ?? null, source: 'sole-live' };
    }
    throw new AmbiguousPortError(descriptors);
}
