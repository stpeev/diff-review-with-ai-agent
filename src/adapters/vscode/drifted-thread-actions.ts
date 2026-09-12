import type { ReviewService } from '../../review/service';

export type DriftedThreadAction = 'fileNote' | 'toggleResolve' | 'delete';

type DriftedThreadService<Thread> = Pick<
  ReviewService<Thread>,
  'delete' | 'keepAsFileNote' | 'markDrifted' | 'reattach' | 'resolve' | 'unresolve'
>;

export interface DriftedThreadActionDeps<Thread> {
  reviewService: DriftedThreadService<Thread>;
  confirmDeletion(): Promise<boolean>;
}

/** Mark a disappeared anchor without allowing the view to define the transition. */
export function markDriftedThread<Thread>(threadId: number, deps: DriftedThreadActionDeps<Thread>): boolean {
  return deps.reviewService.markDrifted(threadId).ok;
}

/** Apply a user-selected correction to a drifted thread through ReviewService. */
export async function applyDriftedThreadAction<Thread>(
  action: DriftedThreadAction,
  threadId: number,
  isResolved: boolean,
  deps: DriftedThreadActionDeps<Thread>,
): Promise<void> {
  switch (action) {
    case 'fileNote':
      deps.reviewService.keepAsFileNote(threadId);
      return;
    case 'toggleResolve':
      if (isResolved) deps.reviewService.unresolve(threadId);
      else deps.reviewService.resolve(threadId);
      return;
    case 'delete':
      if (await deps.confirmDeletion()) deps.reviewService.delete(threadId);
  }
}

/** Re-anchor a drifted thread at the user-confirmed zero-based line. */
export function reattachDriftedThread<Thread>(
  threadId: number,
  line: number,
  deps: DriftedThreadActionDeps<Thread>,
): boolean {
  return deps.reviewService.reattach(threadId, line).ok;
}
