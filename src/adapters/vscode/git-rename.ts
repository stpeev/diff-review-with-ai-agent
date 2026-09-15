import type { GitChange } from './git-api';

/** Return a renamed path when a Git change maps the stored path to its current location. */
export function renamedPathFor(
  previousPath: string,
  changeLists: readonly (readonly GitChange[] | undefined)[],
): string | undefined {
  for (const changes of changeLists) {
    if (!changes) continue;
    for (const change of changes) {
      if (change.originalUri?.fsPath === previousPath && change.uri) return change.uri.fsPath;
    }
  }
  return undefined;
}
