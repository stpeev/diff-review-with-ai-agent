import type { BranchState, ScopeFile, SerializedThread } from '../comment-store';
import { emptyScopeFile } from '../comment-store';

export interface LegacyWorkspaceState {
  version: 1;
  nextThreadId: number;
  nextCommentId: number;
  threads: SerializedThread[];
}

/** Convert populated version-1 workspace state into its first scope-file branch. */
export function migrateLegacyWorkspaceState(
  legacy: LegacyWorkspaceState | undefined,
  branchKey: string,
  writerId: string,
): ScopeFile | undefined {
  if (!legacy || legacy.version !== 1 || legacy.threads.length === 0) return undefined;
  const branch: BranchState = {
    nextThreadId: legacy.nextThreadId,
    nextCommentId: legacy.nextCommentId,
    threads: legacy.threads.map((thread) => ({ ...thread, updatedAt: new Date(0).toISOString() })),
  };
  const file = emptyScopeFile(writerId);
  file.branches[branchKey] = branch;
  return file;
}
