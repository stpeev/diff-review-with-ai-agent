import type { ThreadStatus } from '../comment-store';
import type { ReviewLocation } from './model';
import { commentPreview, type CommentBody } from './presentation';

export type CommentPanelAction =
  | 'submitAll'
  | 'copyAll'
  | 'resolveAll'
  | 'deleteResolved'
  | 'clearAll'
  | 'submitFile'
  | 'copyFile'
  | 'resolveFile'
  | 'deleteResolvedFile'
  | 'commentAction'
  | 'driftedAction'
  | 'reattachAllInFile';

export interface CommentPanelThread {
  id: number;
  file: string;
  startLine: number;
  status: ThreadStatus;
  location: ReviewLocation;
  comments: readonly { body: CommentBody; role?: string }[];
}

export interface CommentPanelItem {
  label: string;
  description?: string;
  separator?: true;
  action?: CommentPanelAction;
  threadId?: number;
  fileKey?: string;
  driftedId?: number;
}

/** Build the comment panel's searchable rows from plain review/view snapshots. */
export function commentPanelItems(threads: readonly CommentPanelThread[], filter = ''): CommentPanelItem[] {
  const items: CommentPanelItem[] = [];
  const lowerFilter = filter.toLowerCase();
  const openCount = threads.filter((thread) => thread.status === 'open').length;
  const resolvedCount = threads.length - openCount;

  items.push(
    { label: '$(send) Submit All Open to Agent', description: `${openCount} open`, action: 'submitAll' },
    { label: '$(clippy) Copy All Open to Clipboard', description: `${openCount} open`, action: 'copyAll' },
    { label: '$(check-all) Resolve All', description: `${openCount} open`, action: 'resolveAll' },
    { label: '$(trash) Delete All Resolved', description: `${resolvedCount} resolved`, action: 'deleteResolved' },
    { label: '$(clear-all) Clear All', description: `${threads.length} total`, action: 'clearAll' },
    { label: '', separator: true },
  );

  const byFile = new Map<string, CommentPanelThread[]>();
  for (const thread of threads) {
    const existing = byFile.get(thread.file) ?? [];
    existing.push(thread);
    byFile.set(thread.file, existing);
  }

  for (const [file, allEntries] of byFile) {
    const liveEntries = allEntries
      .filter((thread) => thread.location.kind !== 'drifted')
      .sort((left, right) => left.startLine - right.startLine);
    const matchingEntries = lowerFilter ? liveEntries.filter((thread) => matches(thread, lowerFilter)) : liveEntries;
    if (matchingEntries.length === 0) continue;

    const fileOpen = allEntries.filter((thread) => thread.status === 'open').length;
    const fileResolved = allEntries.length - fileOpen;
    items.push({ label: `📁 ${file}  (${fileOpen} open, ${fileResolved} resolved)`, separator: true });
    items.push(
      { label: `  $(send) Submit ${file}`, description: `${fileOpen} open`, action: 'submitFile', fileKey: file },
      { label: `  $(clippy) Copy ${file}`, description: `${fileOpen} open`, action: 'copyFile', fileKey: file },
      {
        label: `  $(check-all) Resolve ${file}`,
        description: `${fileOpen} open`,
        action: 'resolveFile',
        fileKey: file,
      },
      {
        label: `  $(trash) Delete Resolved in ${file}`,
        description: `${fileResolved} resolved`,
        action: 'deleteResolvedFile',
        fileKey: file,
      },
    );
    for (const thread of matchingEntries) {
      const replyCount = thread.comments.length - 1;
      const replyInfo = replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : '';
      const roles = thread.comments.map((comment) => (comment.role === 'agent' ? '🤖' : '👤')).join('');
      items.push({
        label: `    ${thread.status === 'resolved' ? '✅' : '💬'} L${thread.startLine + 1}: ${commentPreview(thread.comments)}`,
        description: `${roles}${replyInfo ? `  ${replyInfo}` : ''}`,
        threadId: thread.id,
        action: 'commentAction',
      });
    }
  }

  const drifted = threads.filter((thread) => thread.location.kind === 'drifted');
  if (drifted.length > 0) {
    items.push({ label: `🧩 Needs re-attaching (${drifted.length})`, separator: true });
    const byDriftedFile = new Map<string, CommentPanelThread[]>();
    for (const thread of drifted) {
      const entries = byDriftedFile.get(thread.file) ?? [];
      entries.push(thread);
      byDriftedFile.set(thread.file, entries);
    }
    for (const [file, entries] of byDriftedFile) {
      const matching = lowerFilter ? entries.filter((thread) => matches(thread, lowerFilter)) : entries;
      if (matching.length === 0) continue;
      if (matching.length > 1) {
        items.push({
          label: `  $(sync) Re-attach all in ${file}…`,
          description: `${matching.length} drifted`,
          action: 'reattachAllInFile',
          fileKey: file,
        });
      }
      for (const thread of matching) {
        const lastKnown = thread.location.kind === 'drifted' ? thread.location.lastKnownLine : thread.startLine;
        items.push({
          label: `    🧩 (was L${lastKnown + 1}): ${commentPreview(thread.comments)}`,
          description: file,
          driftedId: thread.id,
          action: 'driftedAction',
        });
      }
    }
  }
  return items;
}

function matches(thread: CommentPanelThread, filter: string): boolean {
  return (
    thread.file.toLowerCase().includes(filter) ||
    thread.comments.some((comment) => {
      const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
      return body.toLowerCase().includes(filter);
    })
  );
}
