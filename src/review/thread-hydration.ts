import type { SerializedThread } from '../comment-store';
import { restoreAnchoredLocation } from './model';

export interface HydratedThreadLocation {
  startLine: number;
  endLine: number;
  drifted: boolean;
  anchorHash?: string;
  anchorContext?: string;
}

/** Restore persisted location intent after optionally checking an anchor against current content. */
export function hydrateThreadLocation(
  thread: SerializedThread,
  verifyAnchor: () => number | 'drifted',
): HydratedThreadLocation {
  if (thread.fileNote) return { startLine: 0, endLine: 0, drifted: false };
  if (thread.drifted) return { startLine: thread.startLine, endLine: thread.endLine, drifted: true };

  const verified = verifyAnchor();
  if (verified === 'drifted') return { startLine: thread.startLine, endLine: thread.endLine, drifted: true };
  const range = restoreAnchoredLocation(thread.startLine, thread.endLine, verified);
  return {
    startLine: range.startLine,
    endLine: range.endLine,
    drifted: false,
    anchorHash: thread.anchorHash,
    anchorContext: thread.anchorContext,
  };
}
