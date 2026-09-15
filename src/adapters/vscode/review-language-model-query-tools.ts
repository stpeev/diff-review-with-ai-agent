import * as vscode from 'vscode';

interface CreateCommentParams {
  path: string;
  line: number;
  endLine?: number;
  text: string;
}

export interface LanguageModelReviewListEntry {
  id: number;
  path: string;
  status: string;
  comments: Array<{ role: string; text: string }>;
  line?: number;
  driftedLine?: number;
}

export interface ReviewLanguageModelQueryToolDeps {
  resolveWorkspacePath(path: string): string | { error: string };
  createComment(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    text: string,
  ): { threadId: number } | { error: string };
  listEntries(): Iterable<LanguageModelReviewListEntry>;
  driftedCount(): number;
  log(message: string): void;
}

/** Register read and create LM tools without coupling their handlers to extension globals. */
export function registerReviewLanguageModelQueryTools(
  subscriptions: vscode.Disposable[],
  deps: ReviewLanguageModelQueryToolDeps,
): void {
  if (!vscode.lm?.registerTool) return;
  subscriptions.push(
    vscode.lm.registerTool('diffReview_listComments', new ListCommentsTool(deps)),
    vscode.lm.registerTool('diffReview_createComment', new CreateCommentTool(deps)),
  );
}

class CreateCommentTool implements vscode.LanguageModelTool<CreateCommentParams> {
  constructor(private readonly deps: ReviewLanguageModelQueryToolDeps) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CreateCommentParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { path, line, endLine, text } = options.input;
    const resolved = this.deps.resolveWorkspacePath(path);
    if (typeof resolved !== 'string') return response(resolved.error);
    const result = this.deps.createComment(vscode.Uri.file(resolved), line - 1, (endLine ?? line) - 1, text);
    if ('error' in result) return response(result.error);
    this.deps.log(`[Diff Review] Comment #${result.threadId} created via LM tool at ${path}:${line}`);
    return response(`Created comment thread #${result.threadId} at ${path}:${line}.`);
  }
}

class ListCommentsTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly deps: ReviewLanguageModelQueryToolDeps) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const entries = [...this.deps.listEntries()];
    this.deps.log(
      `[Diff Review] Comments listed via LM tool (${entries.length} comment(s), ${this.deps.driftedCount()} drifted)`,
    );
    if (entries.length === 0) return response('No review comments.');
    return response(renderLanguageModelReviewList(entries));
  }
}

export function renderLanguageModelReviewList(entries: Iterable<LanguageModelReviewListEntry>): string {
  return [...entries]
    .map((entry) => {
      const where =
        entry.driftedLine !== undefined
          ? `DRIFTED (was ${entry.path}:${entry.driftedLine + 1})`
          : `${entry.path}:${(entry.line ?? 0) + 1}`;
      const comments = entry.comments.map((comment) => `  [${comment.role}] ${comment.text}`).join('\n');
      return `#${entry.id} | ${where} | ${entry.status.toUpperCase()}\n${comments}`;
    })
    .join('\n\n');
}

function response(message: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
