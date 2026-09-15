import { expect, test, vi } from 'vitest';
import type { ReviewBatchCommandDeps, ReviewBatchEntry } from './review-batch-commands';
import { registerReviewBatchCommands } from './review-batch-commands';

function registeredCommands(all: ReviewBatchEntry[], byFile = new Map<string, ReviewBatchEntry[]>()) {
  const handlers = new Map<string, (argument: never) => void | Promise<void>>();
  const resolve = vi.fn(() => ({ ok: true as const, drifted: false }));
  const deleteThread = vi.fn(() => ({ ok: true as const, drifted: false }));
  const confirm = vi.fn(async () => true);
  const showInformation = vi.fn();
  const reviewService: ReviewBatchCommandDeps<unknown>['reviewService'] = { delete: deleteThread, resolve };

  registerReviewBatchCommands([], {
    registerCommand: <T>(command: string, handler: (argument: T) => void | Promise<void>) => {
      handlers.set(command, handler as (argument: never) => void | Promise<void>);
      return { dispose: () => undefined } as never;
    },
    reviewService,
    allEntries: () => all,
    entriesForFile: (fileKey) => byFile.get(fileKey) ?? [],
    confirm,
    showInformation,
  });

  return { confirm, deleteThread, handlers, resolve, showInformation };
}

test('resolve all selects only open entries and reports the count', () => {
  const { handlers, resolve, showInformation } = registeredCommands([
    { id: 1, status: 'open' },
    { id: 2, status: 'resolved' },
    { id: 3, status: 'open' },
  ]);

  handlers.get('diffReview.resolveAll')!(undefined as never);

  expect(resolve).toHaveBeenCalledWith(1);
  expect(resolve).toHaveBeenCalledWith(3);
  expect(showInformation).toHaveBeenCalledWith('Resolved 2 comments.');
});

test('delete resolved requests confirmation before deleting matching entries', async () => {
  const { confirm, deleteThread, handlers } = registeredCommands([
    { id: 1, status: 'open' },
    { id: 2, status: 'resolved' },
  ]);

  await handlers.get('diffReview.deleteResolved')!(undefined as never);

  expect(confirm).toHaveBeenCalledWith('Delete 1 resolved comment?', 'Delete');
  expect(deleteThread).toHaveBeenCalledTimes(1);
  expect(deleteThread).toHaveBeenCalledWith(2);
});

test('clear all does not delete when confirmation is declined', async () => {
  const { confirm, deleteThread, handlers } = registeredCommands([{ id: 1, status: 'open' }]);
  confirm.mockResolvedValue(false);

  await handlers.get('diffReview.clearAll')!(undefined as never);

  expect(deleteThread).not.toHaveBeenCalled();
});

test('per-file batch commands use only entries belonging to the requested file', async () => {
  const { deleteThread, handlers, resolve } = registeredCommands(
    [],
    new Map([
      [
        'src/example.ts',
        [
          { id: 1, status: 'open' },
          { id: 2, status: 'resolved' },
        ],
      ],
    ]),
  );

  handlers.get('diffReview.resolveFile')!('src/example.ts' as never);
  await handlers.get('diffReview.deleteResolvedFile')!('src/example.ts' as never);

  expect(resolve).toHaveBeenCalledWith(1);
  expect(deleteThread).toHaveBeenCalledWith(2);
});
