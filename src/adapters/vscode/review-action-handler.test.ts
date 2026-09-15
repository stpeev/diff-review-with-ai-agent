import { expect, test, vi } from 'vitest';
import type { ReviewActionDeps } from './review-action-handler';
import { executeReviewAction } from './review-action-handler';

function dependencies() {
  const thread = { id: 42 };
  const resolve = vi.fn(() => ({ ok: true as const, drifted: false }));
  const unresolve = vi.fn(() => ({ ok: true as const }));
  const deleteThread = vi.fn(() => ({ ok: true as const, drifted: false }));
  const goTo = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const copy = vi.fn(async () => undefined);
  const confirmDeletion = vi.fn(async () => true);
  const deps: ReviewActionDeps<typeof thread> = {
    reviewService: { delete: deleteThread, resolve, unresolve },
    getThread: (id) => (id === 42 ? thread : undefined),
    goTo,
    send,
    copy,
    confirmDeletion,
  };
  return { confirmDeletion, copy, deleteThread, deps, goTo, resolve, send, thread, unresolve };
}

test('panel actions delegate resolve and reopen to the shared review service', async () => {
  const { deps, resolve, unresolve } = dependencies();

  await executeReviewAction('resolve', 42, deps);
  await executeReviewAction('unresolve', 42, deps);

  expect(resolve).toHaveBeenCalledWith(42);
  expect(unresolve).toHaveBeenCalledWith(42);
});

test('delete action waits for confirmation before mutating the review', async () => {
  const { confirmDeletion, deleteThread, deps } = dependencies();
  confirmDeletion.mockResolvedValue(false);

  await executeReviewAction('delete', 42, deps);

  expect(deleteThread).not.toHaveBeenCalled();
});

test('view actions receive the looked-up thread and unknown handles are ignored', async () => {
  const { deps, goTo, thread } = dependencies();

  await executeReviewAction('goto', 42, deps);
  await executeReviewAction('goto', 99, deps);

  expect(goTo).toHaveBeenCalledOnce();
  expect(goTo).toHaveBeenCalledWith(thread);
});
