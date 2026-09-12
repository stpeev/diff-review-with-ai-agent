import type { ThreadStatus } from '../comment-store';

/**
 * Plain review state shared by persistence and adapters. Lines are zero-based
 * throughout this module; external protocols convert their one-based input at
 * the boundary.
 */
export interface AnchoredLocation {
  kind: 'anchored';
  startLine: number;
  endLine: number;
}

export interface DriftedLocation {
  kind: 'drifted';
  /** The last line where the anchor was known to exist. It is informational. */
  lastKnownLine: number;
}

export interface FileNoteLocation {
  kind: 'file-note';
}

export type ReviewLocation = AnchoredLocation | DriftedLocation | FileNoteLocation;

/** Persistable facts about a review thread, independent of its VS Code view. */
export interface ReviewThreadMetadata {
  status: ThreadStatus;
  location: ReviewLocation;
  anchorHash?: string;
  anchorContext?: string;
  updatedAt: string;
}

export function anchoredLocation(startLine: number, endLine = startLine): AnchoredLocation {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 0 || endLine < startLine) {
    throw new Error('An anchored review location needs a non-negative ordered line range.');
  }
  return { kind: 'anchored', startLine, endLine };
}

/** Preserve a stored multi-line span when its start anchor has moved. */
export function restoreAnchoredLocation(
  storedStartLine: number,
  storedEndLine: number,
  resolvedStartLine = storedStartLine,
): AnchoredLocation {
  const stored = anchoredLocation(storedStartLine, storedEndLine);
  return anchoredLocation(resolvedStartLine, resolvedStartLine + (stored.endLine - stored.startLine));
}

export function driftedLocation(lastKnownLine: number): DriftedLocation {
  if (!Number.isSafeInteger(lastKnownLine) || lastKnownLine < 0) {
    throw new Error('A drifted review location needs a non-negative last-known line.');
  }
  return { kind: 'drifted', lastKnownLine };
}

export function fileNoteLocation(): FileNoteLocation {
  return { kind: 'file-note' };
}

/** Only anchored locations may be used to shift lines or send line-specific feedback. */
export function isActionableLocation(location: ReviewLocation): location is AnchoredLocation {
  return location.kind === 'anchored';
}

export function markLocationDrifted(location: ReviewLocation): DriftedLocation {
  if (location.kind !== 'anchored') {
    throw new Error('Only an anchored review location can drift.');
  }
  return driftedLocation(location.startLine);
}
