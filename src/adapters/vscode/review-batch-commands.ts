import type * as vscode from 'vscode';
import type { ReviewService } from '../../review/service';

export interface ReviewBatchEntry {
  id: number;
  status: 'open' | 'resolved';
}

type ReviewBatchService<Thread> = Pick<ReviewService<Thread>, 'delete' | 'resolve'>;

export interface ReviewBatchCommandDeps<Thread> {
  registerCommand<T>(command: string, handler: (argument: T) => void | Promise<void>): vscode.Disposable;
  reviewService: ReviewBatchService<Thread>;
  allEntries(): Iterable<ReviewBatchEntry>;
  entriesForFile(fileKey: string): Iterable<ReviewBatchEntry>;
  confirm(message: string, action: string): Promise<boolean>;
  showInformation(message: string): void;
}

function plural(count: number): string {
  return `comment${count === 1 ? '' : 's'}`;
}

function open(entries: Iterable<ReviewBatchEntry>): ReviewBatchEntry[] {
  return [...entries].filter((entry) => entry.status === 'open');
}

function resolved(entries: Iterable<ReviewBatchEntry>): ReviewBatchEntry[] {
  return [...entries].filter((entry) => entry.status === 'resolved');
}

/** Register all-file and per-file resolve/delete commands through ReviewService. */
export function registerReviewBatchCommands<Thread>(
  subscriptions: vscode.Disposable[],
  deps: ReviewBatchCommandDeps<Thread>,
): void {
  subscriptions.push(
    deps.registerCommand('diffReview.resolveAll', () => {
      const entries = open(deps.allEntries());
      for (const { id } of entries) deps.reviewService.resolve(id);
      if (entries.length > 0) deps.showInformation(`Resolved ${entries.length} ${plural(entries.length)}.`);
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.deleteResolved', async () => {
      const entries = resolved(deps.allEntries());
      if (entries.length === 0) return deps.showInformation('No resolved comments to delete.');
      if (!(await deps.confirm(`Delete ${entries.length} resolved ${plural(entries.length)}?`, 'Delete'))) return;
      for (const { id } of entries) deps.reviewService.delete(id);
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.clearAll', async () => {
      const entries = [...deps.allEntries()];
      if (entries.length === 0) return;
      if (!(await deps.confirm(`Delete all ${entries.length} review ${plural(entries.length)}?`, 'Delete All'))) return;
      for (const { id } of entries) deps.reviewService.delete(id);
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.resolveFile', (fileKey: string) => {
      const entries = open(deps.entriesForFile(fileKey));
      for (const { id } of entries) deps.reviewService.resolve(id);
      if (entries.length > 0)
        deps.showInformation(`Resolved ${entries.length} ${plural(entries.length)} in ${fileKey}.`);
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.deleteResolvedFile', async (fileKey: string) => {
      const entries = resolved(deps.entriesForFile(fileKey));
      if (entries.length === 0) return deps.showInformation('No resolved comments in this file.');
      if (!(await deps.confirm(`Delete ${entries.length} resolved ${plural(entries.length)} in ${fileKey}?`, 'Delete')))
        return;
      for (const { id } of entries) deps.reviewService.delete(id);
    }),
  );
}
