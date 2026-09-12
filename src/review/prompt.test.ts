import { expect, test } from 'vitest';
import { LM_TOOLS } from '../review-policy';
import { renderReviewPrompt } from './prompt';

test('renderReviewPrompt groups files, orders lines, and retains reply roles', () => {
  const prompt = renderReviewPrompt(
    [
      { id: 2, file: 'src/a.ts', startLine: 8, comments: [{ role: 'user', body: 'Later' }] },
      {
        id: 1,
        file: 'src/a.ts',
        startLine: 2,
        comments: [
          { role: 'user', body: 'First' },
          { role: 'agent', body: 'Done' },
        ],
        codeContext: '→ 3 | const value = 1;',
        diffHunk: '@@ -1 +1 @@',
      },
    ],
    LM_TOOLS,
  );

  expect(prompt.indexOf('Thread #1')).toBeLessThan(prompt.indexOf('Thread #2'));
  expect(prompt).toContain('[user]: First\n[agent]: Done');
  expect(prompt).toContain('```diff\n@@ -1 +1 @@\n```');
});
