/**
 * Pure serialize/merge (F3) and content-anchor (F4) logic for the file-backed
 * comment store.
 *
 * The extension owns every `vscode.CommentThread` and does all file I/O; this
 * module only knows the JSON shape written to `<scope>/comments.json` and how
 * to combine two versions of it when a concurrent writer raced us, plus how to
 * verify/re-find a comment's anchor in a file's current text.
 */
import * as crypto from 'crypto';

export type Role = 'user' | 'agent';
export type ThreadStatus = 'open' | 'resolved';

export interface SerializedComment {
    id: number;
    role: Role;
    body: string;
    timestamp: string;
}

export interface SerializedThread {
    id: number;
    uri: string;
    startLine: number;
    endLine: number;
    status: ThreadStatus;
    comments: SerializedComment[];
    /** Bumped on any mutation to this thread; the merge tiebreaker. */
    updatedAt: string;
    /** F4 content anchor. Absent on threads written before anchoring existed, or once `drifted`. */
    anchorHash?: string;
    /** The anchored line's text plus its context, captured when the anchor was set — shown in the "Needs re-attaching" UI so the user knows what the comment referred to. */
    anchorContext?: string;
    /** True once the anchor could not be found and the thread has left the gutter. */
    drifted?: boolean;
}

export interface BranchState {
    nextThreadId: number;
    nextCommentId: number;
    threads: SerializedThread[];
}

export interface ScopeFile {
    version: 2;
    revision: number;
    writerId: string;
    /** Keyed by branch name; `_default` for scopes with no branch concept (plain folders, detached-without-sha fallback). */
    branches: Record<string, BranchState>;
}

export function emptyBranch(): BranchState {
    return { nextThreadId: 1, nextCommentId: 1, threads: [] };
}

export function emptyScopeFile(writerId: string): ScopeFile {
    return { version: 2, revision: 0, writerId, branches: {} };
}

function mergeBranch(a: BranchState, b: BranchState): BranchState {
    const byId = new Map<number, SerializedThread>();
    for (const t of a.threads) byId.set(t.id, t);
    for (const t of b.threads) {
        const existing = byId.get(t.id);
        if (!existing || t.updatedAt > existing.updatedAt) byId.set(t.id, t);
    }
    const threads = [...byId.values()].sort((x, y) => x.id - y.id);
    return {
        nextThreadId: Math.max(a.nextThreadId, b.nextThreadId),
        nextCommentId: Math.max(a.nextCommentId, b.nextCommentId),
        threads,
    };
}

/**
 * Combine two scope files that diverged from a common ancestor — i.e. a
 * concurrent writer's revision moved past what we last read. Last-write-wins
 * per thread (by `updatedAt`), union of thread ids per branch.
 *
 * Known limitation, inherent to last-write-wins-per-thread without tombstones:
 * a thread deleted on one side but untouched on the other survives the merge.
 * Full delete-under-concurrency needs the soft-delete tombstone from F6.
 */
export function mergeScopeFiles(mine: ScopeFile, theirs: ScopeFile, writerId: string): ScopeFile {
    const branches: Record<string, BranchState> = {};
    const keys = new Set([...Object.keys(mine.branches), ...Object.keys(theirs.branches)]);
    for (const key of keys) {
        branches[key] = mergeBranch(mine.branches[key] ?? emptyBranch(), theirs.branches[key] ?? emptyBranch());
    }
    return {
        version: 2,
        revision: Math.max(mine.revision, theirs.revision) + 1,
        writerId,
        branches,
    };
}

// ---------------- F4: content anchoring ----------------

/** Hash of an anchored line plus its surrounding context — the identity check used to detect drift. */
export function hashAnchor(lineText: string, contextLines: string[]): string {
    const h = crypto.createHash('sha256');
    h.update(lineText);
    h.update('\n---\n');
    h.update(contextLines.join('\n'));
    return h.digest('hex').slice(0, 16);
}

export function anchorContextSnippet(fileLines: string[], line: number, radius: number): string {
    const start = Math.max(0, line - radius);
    const end = Math.min(fileLines.length - 1, line + radius);
    return fileLines.slice(start, end + 1).join('\n');
}

/**
 * Drift ladder, steps 1-3 (see the durability spec): verify at the stored
 * line, then widen the search within `searchRadius`, then scan the whole
 * file. Returns the 0-based line the anchor now lives at, or `undefined` if
 * it is nowhere in this file — at which point the caller tries step 4 (ask
 * git whether the file was renamed) before giving up to step 5 (`drifted`).
 */
export function findAnchorLine(
    fileLines: string[],
    anchorHash: string,
    storedLine: number,
    contextRadius: number,
    searchRadius: number,
): number | undefined {
    const matchesAt = (line: number): boolean => {
        if (line < 0 || line >= fileLines.length) return false;
        const ctx = anchorContextSnippet(fileLines, line, contextRadius).split('\n');
        return hashAnchor(fileLines[line], ctx) === anchorHash;
    };

    if (matchesAt(storedLine)) return storedLine;

    for (let d = 1; d <= searchRadius; d++) {
        if (matchesAt(storedLine - d)) return storedLine - d;
        if (matchesAt(storedLine + d)) return storedLine + d;
    }

    for (let line = 0; line < fileLines.length; line++) {
        if (Math.abs(line - storedLine) <= searchRadius) continue; // already checked above
        if (matchesAt(line)) return line;
    }

    return undefined;
}

// --------------- Ghost (drifted-but-visible) threads ---------------

/**
 * A drifted comment keeps a `vscode.CommentThread` so it stays visible in the
 * Comments panel, but that thread is deliberately not tracked as a live one:
 * its line is the last place the anchor was seen, not a position we still
 * trust. These helpers are the single definition of that distinction, kept
 * here — free of the `vscode` import — so they can be tested directly.
 */

/** The shape a live `ReviewComment` presents to the persistence layer. */
export interface LiveComment {
    id: number;
    role: Role;
    body: string | { value: string };
    createdAt: string;
}

export function serializeComments(comments: readonly LiveComment[]): SerializedComment[] {
    return comments.map(c => ({
        id: c.id,
        role: c.role,
        body: typeof c.body === 'string' ? c.body : c.body.value,
        timestamp: c.createdAt,
    }));
}

export function ghostContextValue(status: ThreadStatus): string {
    return status === 'resolved' ? 'drifted-resolved' : 'drifted-open';
}

export function isGhostContextValue(contextValue: string | undefined): boolean {
    return contextValue === 'drifted-open' || contextValue === 'drifted-resolved';
}

/** Reads the status out of either vocabulary — 'open'/'resolved' for live threads, 'drifted-*' for ghosts. */
export function statusOfContextValue(contextValue: string | undefined): ThreadStatus {
    return contextValue === 'resolved' || contextValue === 'drifted-resolved' ? 'resolved' : 'open';
}

export function ghostLabel(lastKnownLine: number, status: ThreadStatus): string {
    const where = `(was L${lastKnownLine + 1})`;
    return status === 'resolved'
        ? `✅ Resolved · ⚠ Moved ${where}`
        : `⚠ Moved — anchor not found ${where}`;
}

/**
 * Mirror a ghost thread's conversation and status back into the drifted record
 * that owns it — the record, not the thread, is what gets serialized. The
 * position is pointedly not updated: replying to a drifted comment does not
 * make its line trustworthy again, only re-attaching does.
 */
export function applyGhostEdit(
    rec: { comments: SerializedComment[]; status: ThreadStatus; updatedAt: string },
    comments: readonly LiveComment[],
    contextValue: string | undefined,
    now: string,
): void {
    rec.comments = serializeComments(comments);
    rec.status = statusOfContextValue(contextValue);
    rec.updatedAt = now;
}
