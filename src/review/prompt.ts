import type { PolicyTools } from '../review-policy';

export interface PromptComment {
  role: 'user' | 'agent';
  body: string;
}

export interface PromptThread {
  id?: number;
  file: string;
  startLine: number;
  comments: PromptComment[];
  codeContext?: string;
  diffHunk?: string;
}

/**
 * Render review threads as a plain message: the comments themselves, then one
 * closing line that names both destinations — reply in this conversation, and
 * a short summary in the thread itself — along with the tools for each.
 * Deliberately not a procedure: the step-by-step policy exists only in
 * `/address-diff-review` (`sectionedPolicy`), which the user invokes
 * explicitly. Do not grow the policy back in here.
 *
 * The two destinations are not interchangeable. The reply/resolve tools write
 * into the gutter, where only future readers of that thread see them; the
 * answer the user actually reads at the time is the turn in whatever
 * conversation this prompt arrived in — the chat panel for `LM_TOOLS`, the
 * agent's own session for `MCP_TOOLS`. A closing line naming only the tools
 * gets the whole job done inside the gutter and nothing said back, so both
 * belong in this line. It stays a clause on the last line, not a fifth bullet.
 * See src/review/prompt.test.ts.
 */
export function renderReviewPrompt(threads: PromptThread[], tools: PolicyTools): string {
  const byFile = new Map<string, PromptThread[]>();
  for (const thread of threads) {
    const fileThreads = byFile.get(thread.file) ?? [];
    fileThreads.push(thread);
    byFile.set(thread.file, fileThreads);
  }

  const parts: string[] = [];
  for (const [file, fileThreads] of byFile) {
    parts.push(`#### ${file}\n`);
    for (const thread of [...fileThreads].sort((a, b) => a.startLine - b.startLine)) {
      parts.push(
        thread.id === undefined
          ? `#### Line ${thread.startLine + 1}`
          : `#### Line ${thread.startLine + 1} (Thread #${thread.id})`,
      );
      if (thread.codeContext) parts.push('```', thread.codeContext, '```');
      if (thread.diffHunk) parts.push('**Git diff:**', '```diff', thread.diffHunk, '```');
      const body =
        thread.comments.length > 1
          ? thread.comments.map((comment) => `[${comment.role}]: ${comment.body}`).join('\n')
          : (thread.comments[0]?.body ?? '');
      parts.push(`**Comment:** ${body}\n`);
    }
  }
  parts.push(
    `Reply here. Then summarize the reply into the thread with \`${tools.reply}\` (threadId and text); ` +
      `if it makes sense mark it resolved with \`${tools.resolve}\`.`,
  );
  return parts.join('\n');
}
