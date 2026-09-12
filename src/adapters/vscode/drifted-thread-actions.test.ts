import { expect, test, vi } from 'vitest';
import type { DriftedThreadActionDeps } from './drifted-thread-actions';
import { applyDriftedThreadAction, markDriftedThread, reattachDriftedThread } from './drifted-thread-actions';

function dependencies() {
  const markDrifted = vi.fn(() => ({ ok: true as const }));
  const reattach = vi.fn(() => ({ ok: true as const }));
  const keepAsFileNote = vi.fn(() => ({ ok: true as const }));
  const resolve = vi.fn(() => ({ ok: true as const, drifted: true }));
  const unresolve = vi.fn(() => ({ ok: true as const }));
  const deleteThread = vi.fn(() => ({ ok: true as const, drifted: true }));
  const confirmDeletion = vi.fn(async () => true);
  const deps: DriftedThreadActionDeps<unknown> = {
    reviewService: { delete: deleteThread, keepAsFileNote, markDrifted, reattach, resolve, unresolve },
    confirmDeletion,
  };
  return { confirmDeletion, deleteThread, deps, keepAsFileNote, markDrifted, reattach, resolve, unresolve };
}

test('drift lifecycle helpers delegate mark and reattach transitions to the service', () => {
  const { deps, markDrifted, reattach } = dependencies();

  expect(markDriftedThread(42, deps)).toBe(true);
  expect(reattachDriftedThread(42, 6, deps)).toBe(true);
  expect(markDrifted).toHaveBeenCalledWith(42);
  expect(reattach).toHaveBeenCalledWith(42, 6);
});

test('drift actions preserve file-note and resolve/reopen service transitions', async () => {
  const { deps, keepAsFileNote, resolve, unresolve } = dependencies();

  await applyDriftedThreadAction('fileNote', 42, false, deps);
  await applyDriftedThreadAction('toggleResolve', 42, false, deps);
  await applyDriftedThreadAction('toggleResolve', 42, true, deps);

  expect(keepAsFileNote).toHaveBeenCalledWith(42);
  expect(resolve).toHaveBeenCalledWith(42);
  expect(unresolve).toHaveBeenCalledWith(42);
});

test('drift deletion does not mutate when confirmation is declined', async () => {
  const { confirmDeletion, deleteThread, deps } = dependencies();
  confirmDeletion.mockResolvedValue(false);

  await applyDriftedThreadAction('delete', 42, false, deps);

  expect(deleteThread).not.toHaveBeenCalled();
});
