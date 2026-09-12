import type { BranchState, SerializedComment, ThreadStatus } from '../comment-store';
import type { ReviewLocation } from '../review/model';

export interface BranchThreadSnapshot {
  id: number;
  stableId?: string;
  uri: string;
  status: ThreadStatus;
  comments: SerializedComment[];
  location: ReviewLocation;
  anchorHash?: string;
  anchorContext?: string;
  updatedAt: string;
}

/** Converts disposable editor views into a branch record ready for storage. */
export function branchStateFromSnapshots(
  snapshots: Iterable<BranchThreadSnapshot>,
  deletedThreads: Iterable<{ id: number; deletedAt: string }>,
): BranchState {
  const threads: BranchState['threads'] = [];
  let maxThreadId = 0;
  let maxCommentId = 0;

  for (const snapshot of snapshots) {
    maxThreadId = Math.max(maxThreadId, snapshot.id);
    for (const comment of snapshot.comments) maxCommentId = Math.max(maxCommentId, comment.id);
    const drifted = snapshot.location.kind === 'drifted';
    const range =
      snapshot.location.kind === 'anchored'
        ? { startLine: snapshot.location.startLine, endLine: snapshot.location.endLine }
        : snapshot.location.kind === 'file-note'
          ? { startLine: 0, endLine: 0 }
          : { startLine: snapshot.location.lastKnownLine, endLine: snapshot.location.lastKnownLine };
    threads.push({
      id: snapshot.id,
      stableId: snapshot.stableId,
      uri: snapshot.uri,
      ...range,
      status: snapshot.status,
      comments: snapshot.comments,
      updatedAt: snapshot.updatedAt,
      anchorHash: drifted ? undefined : snapshot.anchorHash,
      anchorContext: snapshot.anchorContext,
      drifted: drifted || undefined,
      fileNote: snapshot.location.kind === 'file-note' || undefined,
    });
  }

  const tombstones = [...deletedThreads].sort((left, right) => left.id - right.id);
  for (const tombstone of tombstones) maxThreadId = Math.max(maxThreadId, tombstone.id);
  return { nextThreadId: maxThreadId + 1, nextCommentId: maxCommentId + 1, threads, deletedThreads: tombstones };
}

export interface BranchLoadPlan {
  branch: BranchState;
  inherited: boolean;
}

/** Choose a target branch's own threads, or inherit its populated predecessor. */
export function branchLoadPlan(
  branches: Readonly<Record<string, BranchState>>,
  targetBranchKey: string,
  previousBranchKey?: string,
): BranchLoadPlan | undefined {
  const target = branches[targetBranchKey];
  if (target?.threads.length) return { branch: target, inherited: false };
  const previous = previousBranchKey ? branches[previousBranchKey] : undefined;
  return previous?.threads.length ? { branch: previous, inherited: true } : undefined;
}
