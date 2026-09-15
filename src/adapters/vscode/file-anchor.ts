import { anchorContextSnippet, hashAnchor } from '../../review/anchors';

export interface FileAnchor {
  anchorHash: string;
  anchorContext: string;
}

/** Read a single source location into the persisted anchor representation. */
export function anchorForFileLine(
  filePath: string,
  line: number,
  readTextFile: (filePath: string) => string,
  contextRadius: number,
): FileAnchor | undefined {
  try {
    const lines = readTextFile(filePath).split(/\r\n|\n/);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length) return undefined;
    const context = anchorContextSnippet(lines, line, contextRadius);
    return { anchorHash: hashAnchor(lines[line], context.split('\n')), anchorContext: context };
  } catch {
    return undefined;
  }
}
