import { prosePolicy, type PolicyTools } from '../review-policy';

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

export function renderReviewPrompt(threads: PromptThread[], tools: PolicyTools): string {
  const byFile = new Map<string, PromptThread[]>();
  for (const thread of threads) {
    const fileThreads = byFile.get(thread.file) ?? [];
    fileThreads.push(thread);
    byFile.set(thread.file, fileThreads);
  }

  const parts = [
    threads.length === 1
      ? 'Address only the following review comment. Do not list or act on other open review threads. The comment includes the file, line number, surrounding code context, the git diff (if available), and the comment text itself.\n'
      : 'Inspect the following review comments to the code. Each comment includes the file, line number, surrounding code context, the git diff (if available), and the comment text itself.\n',
  ];
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
  parts.push('---', prosePolicy({ tools, threadRef: 'inline' }));
  return parts.join('\n');
}
