import type { ThreadStatus } from '../comment-store';
import type { ReviewLocation } from './model';

export interface ThreadView {
  status: ThreadStatus;
  location: ReviewLocation;
}

export interface Presentation {
  label: string;
  contextValue: string;
  resolved: boolean;
  collapsed: boolean;
}

export type CommentBody = string | { value: string };

export interface StatusBarPresentation {
  visible: boolean;
  text?: string;
  tooltip?: string;
}

/** Render review and persistence facts for the status bar. */
export function statusBarPresentation(
  total: number,
  open: number,
  drifted: number,
  hasUnpersistedComments: boolean,
): StatusBarPresentation {
  const parts: string[] = [];
  if (total > 0) parts.push(`${open} open · ${total - open} resolved`);
  if (drifted > 0) parts.push(`${drifted} drifted`);
  if (parts.length > 0) {
    return {
      visible: true,
      text: `$(comment-discussion) ${parts.join(' · ')}`,
      tooltip: hasUnpersistedComments
        ? 'Click to view review comments. Some comments in this window are not being saved — see the output log.'
        : 'Click to view review comments',
    };
  }
  return hasUnpersistedComments
    ? {
        visible: true,
        text: '$(warning) Diff Review: not persisted',
        tooltip: 'This window has no workspace folder open — comments will not be saved.',
      }
    : { visible: false };
}

/** Short, single-line preview used wherever a thread is presented in a list. */
export function commentPreview(comments: readonly { body: CommentBody }[], maxLength = 55): string {
  const first = comments[0];
  if (!first) return '';
  const text = typeof first.body === 'string' ? first.body : first.body.value;
  return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
}

/** Render domain state for the VS Code comments view. */
export function presentationFor(view: ThreadView): Presentation {
  const drifted = view.location.kind === 'drifted';
  const resolved = view.status === 'resolved';
  const label =
    view.location.kind === 'drifted'
      ? resolved
        ? `✅ Resolved · ⚠ Moved (was L${view.location.lastKnownLine + 1})`
        : `⚠ Moved — anchor not found (was L${view.location.lastKnownLine + 1})`
      : view.location.kind === 'file-note'
        ? resolved
          ? '✅ Resolved (file note)'
          : 'Open (file note)'
        : resolved
          ? '✅ Resolved'
          : 'Open';
  return {
    label,
    contextValue: drifted ? (resolved ? 'drifted-resolved' : 'drifted-open') : resolved ? 'resolved' : 'open',
    resolved,
    collapsed: resolved || drifted || view.location.kind === 'file-note',
  };
}

export function isDriftedContextValue(contextValue: string | undefined): boolean {
  return contextValue === 'drifted-open' || contextValue === 'drifted-resolved';
}
