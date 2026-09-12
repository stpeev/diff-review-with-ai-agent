import type { ReviewAction } from './review-action-handler';

export interface ActionMenuItem<Action extends string> {
  label: string;
  description?: string;
  action: Action;
}

export interface CommentActionMenu {
  title: string;
  items: ActionMenuItem<ReviewAction>[];
}

/** Present the actions available for an anchored or file-note review thread. */
export function commentActionMenu(input: {
  file: string;
  line: number;
  preview: string;
  resolved: boolean;
}): CommentActionMenu {
  return {
    title: `${input.resolved ? '✅' : '💬'} L${input.line}: ${input.preview}`,
    items: [
      { label: '$(eye) Go to Comment', description: `${input.file}:${input.line}`, action: 'goto' },
      { label: '$(send) Send to Agent', description: 'Submit this comment as a prompt', action: 'send' },
      { label: '$(clippy) Copy to Clipboard', description: 'Copy this comment as a prompt', action: 'copy' },
      {
        label: input.resolved ? '$(debug-restart) Reopen' : '$(check) Resolve',
        action: input.resolved ? 'unresolve' : 'resolve',
      },
      { label: '$(trash) Delete', action: 'delete' },
    ],
  };
}

export type DriftedMenuAction = 'showContext' | 'reattach' | 'searchAgain' | 'fileNote' | 'toggleResolve' | 'delete';

export interface DriftedActionMenu {
  title: string;
  items: ActionMenuItem<DriftedMenuAction>[];
}

/** Present recovery choices for a thread whose prior line can no longer be trusted. */
export function driftedActionMenu(input: {
  file: string;
  preview: string;
  lastKnownLine: number;
  fileExists: boolean;
  resolved: boolean;
}): DriftedActionMenu {
  return {
    title: `🧩 ${input.file}: ${input.preview}`,
    items: [
      {
        label: '$(diff) Show Original Context',
        description: `${input.file} (was L${input.lastKnownLine + 1})`,
        action: 'showContext',
      },
      ...(input.fileExists
        ? [
            {
              label: '$(target) Re-attach…',
              description: 'Place your cursor on the line, then confirm',
              action: 'reattach' as const,
            },
            {
              label: '$(search) Search Again',
              description: 'Re-scan the file for this anchor',
              action: 'searchAgain' as const,
            },
          ]
        : []),
      {
        label: '$(note) Keep as File Note',
        description: 'No specific line — attach to the top of the file',
        action: 'fileNote',
      },
      { label: input.resolved ? '$(debug-restart) Reopen' : '$(check) Resolve', action: 'toggleResolve' },
      { label: '$(trash) Delete', action: 'delete' },
    ],
  };
}
