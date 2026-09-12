import { type ReviewService } from '../review/service';
import { parseIpcRequest, replyRequestSchema, threadMutationRequestSchema } from './contracts';

export interface ReviewMutationRouteDeps<Thread> {
  workspaceMatches(expectedRoot: string | undefined): boolean;
  reviewService: ReviewService<Thread>;
  threadLocation(threadId: number): string | undefined;
}

type MutationAction = 'reply' | 'resolve' | 'unresolve' | 'delete';

export type ReviewMutationRouteResult =
  | {
      status: 200;
      body: Record<string, unknown>;
      action: MutationAction;
      threadId: number;
      drifted: boolean;
      location?: string;
    }
  | { status: 400 | 404; body: { error: string } }
  | { status: 409; body: { error: 'workspace mismatch' } };

/** Validate and dispatch whole-thread IPC mutations through ReviewService. */
export function handleReviewMutationRoute<Thread>(
  pathname: string,
  body: string,
  deps: ReviewMutationRouteDeps<Thread>,
): ReviewMutationRouteResult | undefined {
  if (pathname === '/reply') {
    const { threadId, text, expectWorkspaceRoot } = parseIpcRequest(body, replyRequestSchema);
    if (!deps.workspaceMatches(expectWorkspaceRoot)) return { status: 409, body: { error: 'workspace mismatch' } };
    const location = deps.threadLocation(threadId);
    const result = deps.reviewService.replyFromAgent(threadId, text);
    if (!result.ok) return { status: result.code === 'not-found' ? 404 : 400, body: { error: result.message } };
    return {
      status: 200,
      body: {
        ok: true,
        commentId: result.commentId,
        ...(result.drifted ? { note: 'This thread is drifted — its original location was not found.' } : {}),
      },
      action: 'reply',
      threadId,
      drifted: result.drifted,
      location,
    };
  }

  const action =
    pathname === '/resolve'
      ? 'resolve'
      : pathname === '/unresolve'
        ? 'unresolve'
        : pathname === '/delete'
          ? 'delete'
          : undefined;
  if (!action) return undefined;
  const { threadId, expectWorkspaceRoot } = parseIpcRequest(body, threadMutationRequestSchema);
  if (!deps.workspaceMatches(expectWorkspaceRoot)) return { status: 409, body: { error: 'workspace mismatch' } };
  const location = deps.threadLocation(threadId);
  let drifted = false;
  if (action === 'resolve') {
    const result = deps.reviewService.resolve(threadId);
    if (!result.ok) return { status: 404, body: { error: result.message } };
    drifted = result.drifted;
  } else if (action === 'unresolve') {
    const result = deps.reviewService.unresolve(threadId);
    if (!result.ok) return { status: 404, body: { error: result.message } };
  } else {
    const result = deps.reviewService.delete(threadId);
    if (!result.ok) return { status: 404, body: { error: result.message } };
    drifted = result.drifted;
  }
  return {
    status: 200,
    body: { ok: true },
    action,
    threadId,
    drifted,
    location,
  };
}
