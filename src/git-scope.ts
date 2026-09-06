/**
 * Pure git-scope resolution: turns a `vscode.git` Repository's `state` into
 * the `{ scopeId, branchKey }` pair that names its `comments.json` and the
 * branch inside it.
 *
 * Finding the repo needs the git extension, so that stays in `extension.ts`.
 * The decision this makes — including refusing to answer while `state` is
 * still unpopulated — is testable without a VS Code host.
 */
import { scopeIdForRemote, scopeIdForRepo } from './scope-id';

export interface RepoStateLike {
    remotes?: { fetchUrl?: string; pushUrl?: string }[];
    HEAD?: { name?: string; commit?: string };
}

export interface GitScope {
    scopeId: string;
    branchKey: string;
}

function shortSha(sha: string | undefined): string {
    return (sha ?? 'unknown').slice(0, 8);
}

/**
 * `undefined` means "ask again later", not "not a git repo".
 *
 * `vscode.git` registers a Repository as soon as it finds the folder, before
 * its first status refresh has filled `state` in — so right after an
 * extension-host restart `remotes` is `[]` and `HEAD` is `undefined`.
 * Answering from that empty state picks a `repo:` scope (no remote to key on)
 * on branch `_detached.unknown`, i.e. a different, empty `comments.json`, and
 * the window comes up with no comments. HEAD is the signal: it is set for
 * every real repo, including an unborn branch and a detached checkout, so its
 * absence means the refresh has not landed yet.
 */
export function gitScopeFor(state: RepoStateLike, repoRealPath: string): GitScope | undefined {
    if (!state.HEAD?.name && !state.HEAD?.commit) return undefined;

    const remoteUrl = state.remotes?.[0]?.fetchUrl || state.remotes?.[0]?.pushUrl;
    return {
        scopeId: remoteUrl ? scopeIdForRemote(remoteUrl) : scopeIdForRepo(repoRealPath),
        branchKey: state.HEAD?.name || `_detached.${shortSha(state.HEAD?.commit)}`,
    };
}
