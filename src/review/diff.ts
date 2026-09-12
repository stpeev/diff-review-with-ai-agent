export interface DiffHunk {
  header: string;
  lines: string[];
}

/** Extract the hunks for one repository-relative file from a Git diff. */
export function diffHunksForFile(fullDiff: string, relativePath: string): DiffHunk[] {
  const fileSections = fullDiff.split(/^(?=diff --git )/m);
  const targetPrefix = `diff --git a/${relativePath} b/${relativePath}`;
  const fileSection = fileSections.find((section) => section.startsWith(targetPrefix));
  if (!fileSection) return [];
  return fileSection
    .split(/^(?=@@)/m)
    .filter((part) => part.startsWith('@@'))
    .map((part) => {
      const lines = part.split('\n');
      const body = lines.slice(1);
      while (body.at(-1) === '') body.pop();
      return { header: lines[0], lines: body };
    });
}

/** Return a bounded hunk context for a one-based target line. */
export function relevantDiffHunk(hunks: readonly DiffHunk[], targetLine: number): string | undefined {
  for (const hunk of hunks) {
    const match = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const newStart = parseInt(match[3], 10);
    const newEnd = newStart + parseInt(match[4] ?? '1', 10) - 1;
    if (targetLine < newStart || targetLine > newEnd) continue;
    const allLines = [hunk.header, ...hunk.lines];
    if (allLines.length <= 20) return allLines.join('\n');
    let newLine = newStart;
    let bestIndex = 1;
    for (let index = 1; index < allLines.length; index++) {
      if (allLines[index].startsWith('-')) continue;
      if (newLine++ === targetLine) {
        bestIndex = index;
        break;
      }
    }
    return [hunk.header, ...allLines.slice(Math.max(1, bestIndex - 7), Math.min(allLines.length, bestIndex + 7))].join(
      '\n',
    );
  }
  return undefined;
}
