/**
 * Pure serialize/merge (F3) and content-anchor (F4) logic for the file-backed
 * comment store.
 *
 * The extension owns every `vscode.CommentThread` and does all file I/O; this
 * module only knows the JSON shape written to `<scope>/comments.json` and how
 * to combine two versions of it when a concurrent writer raced us, plus how to
 * verify/re-find a comment's anchor in a file's current text.
 */
import { createHash } from 'node:crypto';

export type Role = 'user' | 'agent';
export type ThreadStatus = 'open' | 'resolved';

export interface SerializedComment {
  id: number;
  /** Collision-resistant persisted identity; numeric id remains the public compatibility handle. */
  stableId?: string;
  role: Role;
  body: string;
  timestamp: string;
}

export interface SerializedThread {
  id: number;
  /** Collision-resistant persisted identity; numeric id remains the public compatibility handle. */
  stableId?: string;
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
  /** True when the user deliberately converted the thread into a file-level note. */
  fileNote?: boolean;
}

/** Records a deletion long enough for concurrent writers to observe it. */
export interface DeletedThread {
  id: number;
  deletedAt: string;
}

export interface BranchState {
  nextThreadId: number;
  nextCommentId: number;
  threads: SerializedThread[];
  /** Optional for compatibility with version-2 files written before tombstones. */
  deletedThreads?: DeletedThread[];
}

export interface ScopeFile {
  version: 2 | 3;
  revision: number;
  writerId: string;
  /** Keyed by branch name; `_default` for scopes with no branch concept (plain folders, detached-without-sha fallback). */
  branches: Record<string, BranchState>;
}

export function emptyBranch(): BranchState {
  return { nextThreadId: 1, nextCommentId: 1, threads: [] };
}

export function emptyScopeFile(writerId: string): ScopeFile {
  return { version: 3, revision: 0, writerId, branches: {} };
}

function mergeComments(a: SerializedThread, b: SerializedThread, preferred: SerializedThread): SerializedComment[] {
  const comments = new Map<string, SerializedComment>();
  const conflictCopy = (comment: SerializedComment): SerializedComment => ({
    ...comment,
    stableId: comment.stableId
      ? createHash('sha256')
          .update(JSON.stringify([comment.stableId, comment.timestamp, comment.role, comment.body]))
          .digest('hex')
      : undefined,
  });
  const add = (comment: SerializedComment, prefer: boolean) => {
    // A comment edit retains its public ID and creation timestamp, while two
    // independently-created replies share neither timestamp nor content.
    const key = comment.stableId ? `stable:${comment.stableId}` : `${comment.id}\u0000${comment.timestamp}`;
    const existing = comments.get(key);
    if (!existing) {
      comments.set(key, comment);
    } else if (existing.role === comment.role && existing.body === comment.body) {
      if (prefer) comments.set(key, comment);
    } else {
      // Same persisted comment identity with different text is a concurrent
      // edit. Retain both versions and let ID normalization give the second
      // one a distinct public comment handle rather than destroying content.
      const conflictKey = `${key}\u0000${comment.role}\u0000${comment.body}`;
      if (prefer && comment.stableId && existing.stableId) {
        comments.set(key, comment);
        comments.set(conflictKey, conflictCopy(existing));
      } else {
        comments.set(conflictKey, conflictCopy(comment));
      }
    }
  };
  for (const comment of a.comments) add(comment, preferred === a);
  for (const comment of b.comments) add(comment, preferred === b);
  return [...comments.values()].sort(
    (left, right) => left.timestamp.localeCompare(right.timestamp) || left.id - right.id,
  );
}

function mergeThread(a: SerializedThread, b: SerializedThread): SerializedThread {
  const preferred = b.updatedAt > a.updatedAt ? b : a;
  return { ...preferred, comments: mergeComments(a, b, preferred) };
}

function sharesPersistedComment(a: SerializedThread, b: SerializedThread): boolean {
  return a.comments.some((left) =>
    b.comments.some((right) => left.id === right.id && left.timestamp === right.timestamp && left.role === right.role),
  );
}

function ensureUniqueThreadIds(threads: SerializedThread[], reservedIds: ReadonlySet<number>): SerializedThread[] {
  const used = new Set<number>();
  let nextId = Math.max(0, ...reservedIds, ...threads.map((thread) => thread.id)) + 1;
  return threads.map((thread) => {
    if (!used.has(thread.id) && !reservedIds.has(thread.id)) {
      used.add(thread.id);
      return thread;
    }
    while (used.has(nextId) || reservedIds.has(nextId)) nextId++;
    const replacement = { ...thread, id: nextId++ };
    used.add(replacement.id);
    return replacement;
  });
}

function ensureUniqueCommentIds(threads: SerializedThread[]): SerializedThread[] {
  const used = new Set<number>();
  let nextId = Math.max(0, ...threads.flatMap((thread) => thread.comments.map((comment) => comment.id))) + 1;
  return threads.map((thread) => ({
    ...thread,
    comments: thread.comments.map((comment) => {
      if (!used.has(comment.id)) {
        used.add(comment.id);
        return comment;
      }
      const replacement = { ...comment, id: nextId++ };
      used.add(replacement.id);
      return replacement;
    }),
  }));
}

function mergeBranch(a: BranchState, b: BranchState): BranchState {
  const candidates = [...a.threads];
  for (const t of b.threads) {
    const existingIndex = candidates.findIndex((candidate) =>
      candidate.stableId && t.stableId
        ? candidate.stableId === t.stableId
        : candidate.id === t.id && sharesPersistedComment(candidate, t),
    );
    if (existingIndex === -1) candidates.push(t);
    else candidates[existingIndex] = mergeThread(candidates[existingIndex], t);
  }
  const deletedById = new Map<number, DeletedThread>();
  for (const tombstone of [...(a.deletedThreads ?? []), ...(b.deletedThreads ?? [])]) {
    const existing = deletedById.get(tombstone.id);
    if (!existing || tombstone.deletedAt > existing.deletedAt) deletedById.set(tombstone.id, tombstone);
  }
  const surviving = candidates.filter((thread) => {
    const tombstone = deletedById.get(thread.id);
    if (!tombstone) return true;
    if (tombstone.deletedAt >= thread.updatedAt) return false;
    deletedById.delete(thread.id);
    return true;
  });
  const threads = ensureUniqueCommentIds(
    ensureUniqueThreadIds(
      surviving.sort((left, right) => left.id - right.id || left.updatedAt.localeCompare(right.updatedAt)),
      new Set(deletedById.keys()),
    ),
  );
  const deletedThreads = [...deletedById.values()].sort((x, y) => x.id - y.id);
  return {
    nextThreadId: Math.max(
      a.nextThreadId,
      b.nextThreadId,
      ...deletedThreads.map((thread) => thread.id + 1),
      ...threads.map((thread) => thread.id + 1),
    ),
    nextCommentId: Math.max(
      a.nextCommentId,
      b.nextCommentId,
      ...threads.flatMap((thread) => thread.comments.map((comment) => comment.id + 1)),
    ),
    threads,
    deletedThreads,
  };
}

/**
 * Combine two scope files that diverged from a common ancestor — i.e. a
 * concurrent writer's revision moved past what we last read. Last-write-wins
 * per thread (by `updatedAt`), union of thread ids per branch.
 *
 * A newer tombstone wins over an unchanged or older live thread, preventing a
 * concurrent merge from resurrecting a deletion. A later thread update wins
 * deterministically and removes its older tombstone.
 */
export function mergeScopeFiles(mine: ScopeFile, theirs: ScopeFile, writerId: string): ScopeFile {
  const branches: Record<string, BranchState> = {};
  const keys = new Set([...Object.keys(mine.branches), ...Object.keys(theirs.branches)]);
  for (const key of keys) {
    branches[key] = mergeBranch(mine.branches[key] ?? emptyBranch(), theirs.branches[key] ?? emptyBranch());
  }
  return {
    version: 3,
    revision: Math.max(mine.revision, theirs.revision) + 1,
    writerId,
    branches,
  };
}

/**
 * Give version-2 records written before stable identities existed deterministic
 * identities. The backfill is pure, so loading the same legacy file in two
 * windows cannot invent competing identities before either window saves it.
 */
export function backfillStableIds(file: ScopeFile): ScopeFile {
  const stableId = (kind: string, value: unknown) =>
    createHash('sha256')
      .update(JSON.stringify([kind, value]))
      .digest('hex');
  return {
    ...file,
    version: 3,
    branches: Object.fromEntries(
      Object.entries(file.branches).map(([branchKey, branch]) => [
        branchKey,
        {
          ...branch,
          threads: branch.threads.map((thread) => ({
            ...thread,
            stableId:
              thread.stableId ??
              stableId('thread', [
                branchKey,
                thread.id,
                thread.uri,
                thread.startLine,
                thread.endLine,
                thread.updatedAt,
              ]),
            comments: thread.comments.map((comment) => ({
              ...comment,
              stableId:
                comment.stableId ??
                stableId('comment', [branchKey, thread.id, comment.id, comment.role, comment.timestamp, comment.body]),
            })),
          })),
        },
      ]),
    ),
  };
}

// --------------- Thread presentation ---------------

/**
 * A comment lives in exactly one place — a `vscode.CommentThread` tracked by
 * id. Drift is a *property* of that thread, not a separate container: a
 * drifted comment is one whose line the anchor ladder no longer vouches for,
 * so it must be skipped by anything that shifts or re-verifies positions, but
 * it is otherwise an ordinary thread that replies, resolves and serializes
 * like any other.
 *
 * `presentationFor` is the single definition of how each combination looks in
 * the Comments panel, so no call site has to assemble a label and a
 * contextValue by hand and risk the two disagreeing.
 */

/** The shape a live `ReviewComment` presents to the persistence layer. */
export interface LiveComment {
  id: number;
  stableId?: string;
  role: Role;
  body: string | { value: string };
  createdAt: string;
}

export function serializeComments(comments: readonly LiveComment[]): SerializedComment[] {
  return comments.map((c) => ({
    id: c.id,
    ...(c.stableId ? { stableId: c.stableId } : {}),
    role: c.role,
    body: typeof c.body === 'string' ? c.body : c.body.value,
    timestamp: c.createdAt,
  }));
}
