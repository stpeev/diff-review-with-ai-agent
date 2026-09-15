import * as crypto from 'node:crypto';

/** Hash of an anchored line plus its surrounding context. */
export function hashAnchor(lineText: string, contextLines: string[]): string {
  const hash = crypto.createHash('sha256');
  hash.update(lineText);
  hash.update('\n---\n');
  hash.update(contextLines.join('\n'));
  return hash.digest('hex').slice(0, 16);
}

export function anchorContextSnippet(fileLines: string[], line: number, radius: number): string {
  const start = Math.max(0, line - radius);
  const end = Math.min(fileLines.length - 1, line + radius);
  return fileLines.slice(start, end + 1).join('\n');
}

/**
 * Verify an anchor at its stored line, then search nearby and finally across
 * the file. The caller decides whether a miss becomes a drifted location.
 */
export function findAnchorLine(
  fileLines: string[],
  anchorHash: string,
  storedLine: number,
  contextRadius: number,
  searchRadius: number,
): number | undefined {
  const matchesAt = (line: number): boolean => {
    if (line < 0 || line >= fileLines.length) return false;
    const context = anchorContextSnippet(fileLines, line, contextRadius).split('\n');
    return hashAnchor(fileLines[line], context) === anchorHash;
  };

  if (matchesAt(storedLine)) return storedLine;
  for (let distance = 1; distance <= searchRadius; distance++) {
    if (matchesAt(storedLine - distance)) return storedLine - distance;
    if (matchesAt(storedLine + distance)) return storedLine + distance;
  }
  for (let line = 0; line < fileLines.length; line++) {
    if (Math.abs(line - storedLine) > searchRadius && matchesAt(line)) return line;
  }
  return undefined;
}
