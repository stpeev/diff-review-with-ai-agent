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
 * Render review threads as a plain message: the comments themselves, then a
 * single closing line naming the reply and resolve tools. Deliberately not a
 * procedure — the step-by-step policy exists only in `/address-diff-review`
 * (`sectionedPolicy`), which the user invokes explicitly. Do not grow the
 * policy back in here.
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
    `Reply in each thread with \`${tools.reply}\` (threadId and text); \`${tools.resolve}\` marks it resolved.`,
  );
  return parts.join('\n');
}
