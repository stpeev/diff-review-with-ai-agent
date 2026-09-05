/**
 * Pure scope resolution (F3): turns "a git remote URL" or "a realpath" into a
 * stable id for `<globalStorageUri>/scopes/<scopeId>/comments.json`.
 *
 * Resolving *which* input applies (is there a repo, does it have a remote,
 * what is the folder's realpath) needs the filesystem and the git extension,
 * so that lives in `extension.ts`. This module only formats what it is given,
 * so the formatting rules are testable without either.
 */
import * as crypto from 'crypto';
import { deepestAncestor } from './path-util';

function sha256(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Best-effort normalization so the same remote in the same protocol always
 * hashes the same way: strips embedded credentials, a trailing `.git`, and a
 * trailing slash; lower-cases the host. Does not attempt to equate different
 * protocols for the same repo (ssh vs https) — that is a stronger claim than
 * this needs to make.
 */
export function normalizeRemoteUrl(url: string): string {
    let u = url.trim();

    // scp-like ssh form: git@host:owner/repo(.git) -> ssh://host/owner/repo
    const scp = u.match(/^([\w.-]+)@([\w.-]+):(.+)$/);
    if (scp && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
        u = `ssh://${scp[2]}/${scp[3]}`;
    }

    u = u.replace(/\.git\/?$/i, '').replace(/\/+$/, '');

    try {
        const parsed = new URL(u);
        parsed.username = '';
        parsed.password = '';
        return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`;
    } catch {
        // Not a URL esbuild's URL() can parse (e.g. a bare local path) — fall
        // back to a lower-cased, trimmed string rather than throwing.
        return u.toLowerCase();
    }
}

export function scopeIdForRemote(remoteUrl: string): string {
    return `remote:${normalizeRemoteUrl(remoteUrl)}`;
}

export function scopeIdForRepo(realRepoRoot: string): string {
    return `repo:${sha256(realRepoRoot).slice(0, 32)}`;
}

export function scopeIdForFolder(realFolderPath: string): string {
    return `folder:${sha256(realFolderPath).slice(0, 32)}`;
}

/** Filesystem-safe directory name for a scope id (":" and "/" are not valid on every platform). */
export function scopeDirName(scopeId: string): string {
    return scopeId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export interface ScopeCandidate {
    scopeId: string;
    /** The workspace folder (realpath) this candidate was resolved for. */
    folderRealPath: string;
}

/** The candidate whose folder is the deepest ancestor of `filePath` — resolves multi-root and mixed git/non-git workspaces. */
export function deepestScopeForFile(candidates: ScopeCandidate[], filePath: string): ScopeCandidate | undefined {
    return deepestAncestor(candidates, c => c.folderRealPath, filePath);
}
