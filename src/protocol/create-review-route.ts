import { createRequestSchema, parseIpcRequest } from './contracts';

export interface CreateReviewRouteDeps {
  workspaceMatches(expectedRoot: string | undefined): boolean;
  resolvePath(expectedRoot: string | undefined, relativePath: string): string | { error: string };
  createComment(
    filePath: string,
    startLine: number,
    endLine: number,
    text: string,
  ): { threadId: number } | { error: string };
}

export type CreateReviewRouteResult =
  | { status: 200; body: { ok: true; threadId: number } }
  | { status: 400; body: { error: string } }
  | { status: 409; body: { error: 'workspace mismatch' } };

/** Validate a create request before adapting its path and line range to a review-thread creation effect. */
export function handleCreateReviewRoute(body: string, deps: CreateReviewRouteDeps): CreateReviewRouteResult {
  const { path, line, endLine, text, expectWorkspaceRoot } = parseIpcRequest(body, createRequestSchema);
  if (!deps.workspaceMatches(expectWorkspaceRoot)) return { status: 409, body: { error: 'workspace mismatch' } };

  const resolved = deps.resolvePath(expectWorkspaceRoot, path);
  if (typeof resolved !== 'string') return { status: 400, body: { error: resolved.error } };
  const created = deps.createComment(resolved, line - 1, (endLine ?? line) - 1, text);
  return 'error' in created
    ? { status: 400, body: { error: created.error } }
    : { status: 200, body: { ok: true, threadId: created.threadId } };
}
