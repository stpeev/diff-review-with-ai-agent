import { mergeScopeFiles, type BranchState, type ScopeFile } from '../comment-store';

export interface BranchCommitInput {
  onDisk: ScopeFile;
  lastKnownFile?: ScopeFile;
  lastLoadedRevision: number;
  branchKey: string;
  branch: BranchState;
  writerId: string;
}

/**
 * Construct the next scope file for a branch save. A matching revision permits
 * replacing the branch directly so a local deletion stays deleted; a changed
 * revision takes the operation-aware concurrent merge path instead.
 */
export function commitBranchState(input: BranchCommitInput): ScopeFile {
  const { onDisk, lastKnownFile, lastLoadedRevision, branchKey, branch, writerId } = input;
  if (lastKnownFile && onDisk.revision === lastLoadedRevision) {
    return {
      ...onDisk,
      writerId,
      revision: onDisk.revision + 1,
      branches: { ...onDisk.branches, [branchKey]: branch },
    };
  }
  const base = lastKnownFile ?? onDisk;
  const mine: ScopeFile = { ...base, writerId, branches: { ...base.branches, [branchKey]: branch } };
  return mergeScopeFiles(mine, onDisk, writerId);
}
