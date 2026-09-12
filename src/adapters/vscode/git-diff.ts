import * as path from 'node:path';
import { diffHunksForFile, type DiffHunk } from '../../review/diff';
import type { GitApi } from './git-api';

export interface FileUri {
  fsPath: string;
}

/** Fetch and parse the staged and unstaged Git diff for one VS Code file. */
export async function getFileDiffHunks(
  uri: FileUri,
  getGitApi: () => Pick<GitApi, 'repositories'> | undefined,
): Promise<DiffHunk[]> {
  try {
    const git = getGitApi();
    if (!git) return [];
    const repo = git.repositories.find((candidate) => uri.fsPath.startsWith(candidate.rootUri.fsPath));
    if (!repo) return [];
    const fullDiff = `${(await repo.diff(false)) || ''}\n${(await repo.diff(true)) || ''}`;
    if (!fullDiff.trim()) return [];
    const relativePath = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
    return diffHunksForFile(fullDiff, relativePath);
  } catch {
    return [];
  }
}
