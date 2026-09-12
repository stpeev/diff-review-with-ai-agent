import type { ReviewService } from '../../review/service';

export type ReviewAction = 'goto' | 'send' | 'copy' | 'resolve' | 'unresolve' | 'delete';

type ReviewActionService<Thread> = Pick<ReviewService<Thread>, 'delete' | 'resolve' | 'unresolve'>;

export interface ReviewActionDeps<Thread> {
  reviewService: ReviewActionService<Thread>;
  getThread(threadId: number): Thread | undefined;
  goTo(thread: Thread): Promise<void>;
  send(thread: Thread): Promise<void>;
  copy(thread: Thread): Promise<void>;
  confirmDeletion(): Promise<boolean>;
}

/** Execute an action chosen in the comment panel through the shared service. */
export async function executeReviewAction<Thread>(
  action: ReviewAction,
  threadId: number,
  deps: ReviewActionDeps<Thread>,
): Promise<void> {
  const thread = deps.getThread(threadId);
  if (!thread) return;
  switch (action) {
    case 'goto':
      return deps.goTo(thread);
    case 'send':
      return deps.send(thread);
    case 'copy':
      return deps.copy(thread);
    case 'resolve':
      deps.reviewService.resolve(threadId);
      return;
    case 'unresolve':
      deps.reviewService.unresolve(threadId);
      return;
    case 'delete':
      if (await deps.confirmDeletion()) deps.reviewService.delete(threadId);
  }
}
