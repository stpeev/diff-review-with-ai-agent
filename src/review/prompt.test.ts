import { expect, test } from 'vitest';
import { LM_TOOLS, MCP_TOOLS } from '../review-policy';
import { renderReviewPrompt, type PromptThread } from './prompt';

const oneThread: PromptThread[] = [
  { id: 1, file: 'src/a.ts', startLine: 2, comments: [{ role: 'user', body: 'First' }] },
];

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

test('renderReviewPrompt is the comments plus one closing line, not a procedure', () => {
  const prompt = renderReviewPrompt(oneThread, LM_TOOLS);

  // It opens on the payload — no preamble addressing the agent.
  expect(prompt.startsWith('#### src/a.ts\n')).toBe(true);
  // The five-step policy and its bullet rendering stay in /address-diff-review.
  for (const policyText of [
    'Inspect each open thread',
    'Reply to every thread you touch',
    'Resolve only what you actually addressed',
    'Never commit',
    '- **',
  ]) {
    expect(prompt).not.toContain(policyText);
  }
});

test("renderReviewPrompt closes by naming the session's reply and resolve tools", () => {
  const lm = renderReviewPrompt(oneThread, LM_TOOLS);
  expect(lm).toContain('`diffReview_replyToComment` (threadId and text)');
  expect(lm).toContain('`diffReview_resolveComment`');

  const mcp = renderReviewPrompt(oneThread, MCP_TOOLS);
  expect(mcp).toContain('`replyToDiffComment` (threadId and text)');
  expect(mcp).toContain('`resolveDiffComment`');
});
