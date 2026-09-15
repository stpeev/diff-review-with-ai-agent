import { expect, test } from 'vitest';
import { diffHunksForFile, relevantDiffHunk } from './diff';

const diff = `diff --git a/a.ts b/a.ts
@@ -1,2 +1,3 @@
 one
-two
+two changed
+three
diff --git a/b.ts b/b.ts
@@ -4 +4 @@
-old
+new
`;

test('diffHunksForFile isolates one file and relevantDiffHunk uses new-file lines', () => {
  const hunks = diffHunksForFile(diff, 'a.ts');

  expect(hunks).toEqual([{ header: '@@ -1,2 +1,3 @@', lines: [' one', '-two', '+two changed', '+three'] }]);
  expect(relevantDiffHunk(hunks, 3)).toContain('+three');
  expect(relevantDiffHunk(hunks, 4)).toBeUndefined();
  expect(diffHunksForFile(diff, 'missing.ts')).toEqual([]);
});
