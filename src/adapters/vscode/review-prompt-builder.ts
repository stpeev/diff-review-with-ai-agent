import type { DiffHunk } from '../../review/diff';
import { relevantDiffHunk } from '../../review/diff';
import type { PromptThread } from '../../review/prompt';

export interface PromptRange {
  start: { line: number };
  end: { line: number };
}

export interface PromptDocument {
  lineCount: number;
  lineAt(line: number): { text: string };
}

export interface PromptComment {
  role?: 'user' | 'agent';
  body: string | { value: string };
}

export interface PromptThreadView<Uri> {
  uri: Uri;
  comments: readonly PromptComment[];
}

export interface ReviewPromptBuilderDeps<Uri, Thread extends PromptThreadView<Uri>> {
  uriKey(uri: Uri): string;
  displayPath(uri: Uri): string;
  range(thread: Thread): PromptRange;
  threadId(thread: Thread): number | undefined;
  diffHunks(uri: Uri): Promise<DiffHunk[]>;
  document(uri: Uri): Promise<PromptDocument>;
}

/** Adapt VS Code view objects into plain prompt data without embedding policy rendering in the extension entry point. */
export async function buildPromptThreads<Uri, Thread extends PromptThreadView<Uri>>(
  deps: ReviewPromptBuilderDeps<Uri, Thread>,
  targetThreads: readonly Thread[],
): Promise<PromptThread[]> {
  const byFile = new Map<string, { uri: Uri; threads: Thread[] }>();
  for (const thread of targetThreads) {
    const key = deps.uriKey(thread.uri);
    const entry = byFile.get(key) ?? { uri: thread.uri, threads: [] };
    entry.threads.push(thread);
    byFile.set(key, entry);
  }

  const promptThreads: PromptThread[] = [];
  for (const { uri, threads } of byFile.values()) {
    const hunks = await deps.diffHunks(uri);
    const sorted = [...threads].sort((left, right) => deps.range(left).start.line - deps.range(right).start.line);
    for (const thread of sorted) {
      const range = deps.range(thread);
      const line = range.start.line + 1;
      let codeContext: string | undefined;
      try {
        const document = await deps.document(uri);
        const start = Math.max(0, range.start.line - 2);
        const end = Math.min(document.lineCount - 1, range.end.line + 2);
        const lines: string[] = [];
        for (let index = start; index <= end; index++) {
          lines.push(`${index === range.start.line ? '→' : ' '} ${index + 1} | ${document.lineAt(index).text}`);
        }
        codeContext = lines.join('\n') || undefined;
      } catch {
        // A prompt without local context remains useful when the file cannot be opened.
      }

      promptThreads.push({
        id: deps.threadId(thread),
        file: deps.displayPath(uri),
        startLine: line - 1,
        comments: thread.comments.map((comment) => ({
          role: comment.role ?? 'user',
          body: typeof comment.body === 'string' ? comment.body : comment.body.value,
        })),
        codeContext,
        diffHunk: relevantDiffHunk(hunks, line),
      });
    }
  }
  return promptThreads;
}
