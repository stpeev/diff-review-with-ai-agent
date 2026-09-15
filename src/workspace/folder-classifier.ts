export type FolderClassification<Repository> =
  | { state: 'plain'; scopeId: string; branchKey: '_default' }
  | { state: 'git'; scopeId: string; branchKey: string; repository: Repository };

export interface FolderClassificationDeps<Repository> {
  isCurrent(): boolean;
  hasDotGit(): boolean;
  plainScopeId(): string;
  resolveGit(): Promise<{ scopeId: string; branchKey: string; repository: Repository } | undefined>;
  now(): number;
  wait(milliseconds: number): Promise<void>;
  pendingTimeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Resolve a workspace folder's persisted scope. A Git repository is only
 * accepted after its extension API has supplied a populated scope; otherwise
 * it degrades to a stable plain-folder scope after a bounded wait.
 */
export async function classifyWorkspaceFolder<Repository>(
  deps: FolderClassificationDeps<Repository>,
): Promise<FolderClassification<Repository> | undefined> {
  if (!deps.isCurrent()) return undefined;
  if (!deps.hasDotGit()) return { state: 'plain', scopeId: deps.plainScopeId(), branchKey: '_default' };

  const initial = await resolveCurrentGit(deps);
  if (initial) return initial;

  const deadline = deps.now() + deps.pendingTimeoutMs;
  while (deps.now() < deadline) {
    await deps.wait(deps.pollIntervalMs);
    const resolved = await resolveCurrentGit(deps);
    if (resolved) return resolved;
    if (!deps.isCurrent()) return undefined;
  }
  return deps.isCurrent() ? { state: 'plain', scopeId: deps.plainScopeId(), branchKey: '_default' } : undefined;
}

async function resolveCurrentGit<Repository>(
  deps: FolderClassificationDeps<Repository>,
): Promise<FolderClassification<Repository> | undefined> {
  const resolved = await deps.resolveGit();
  if (!deps.isCurrent() || !resolved) return undefined;
  return { state: 'git', ...resolved };
}
