import type { RepoStateLike } from '../../git-scope';

export interface GitUri {
  fsPath: string;
}

export interface GitChange {
  uri?: GitUri;
  originalUri?: GitUri;
}

export interface GitRepository {
  rootUri: GitUri;
  state: RepoStateLike & {
    workingTreeChanges?: readonly GitChange[];
    indexChanges?: readonly GitChange[];
    onDidChange(listener: () => void): unknown;
  };
  diff(staged: boolean): Promise<string | undefined>;
}

export interface GitApi {
  repositories: readonly GitRepository[];
  onDidOpenRepository(listener: () => void): unknown;
}
