import { findAnchorLine } from './anchors';

export interface AnchorRestorationDeps {
  fileExists(filePath: string): boolean;
  readTextFile(filePath: string): string;
  renamedPath(filePath: string): string | undefined;
}

/** Restore an anchored line, retaining legacy records and reporting drift explicitly. */
export function restoreAnchorLine(
  filePath: string,
  startLine: number,
  anchorHash: string | undefined,
  deps: AnchorRestorationDeps,
  contextRadius: number,
  searchRadius: number,
): number | 'drifted' {
  if (!anchorHash) return startLine;
  const target = deps.fileExists(filePath) ? filePath : deps.renamedPath(filePath);
  if (!target) return 'drifted';
  try {
    const found = findAnchorLine(
      deps.readTextFile(target).split(/\r\n|\n/),
      anchorHash,
      startLine,
      contextRadius,
      searchRadius,
    );
    return found === undefined ? 'drifted' : found;
  } catch {
    return 'drifted';
  }
}
