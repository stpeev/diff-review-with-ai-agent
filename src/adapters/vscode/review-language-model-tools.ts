import * as vscode from 'vscode';
import type { ReviewService } from '../../review/service';

interface ReplyParams {
  /** Legacy external name: this identifies the review thread, not one reply. */
  commentId: number;
  text: string;
}

interface ThreadHandleParam {
  /** Legacy external name: this identifies the review thread, not one reply. */
  commentId: number;
}

type LanguageModelMutationService<Thread> = Pick<ReviewService<Thread>, 'delete' | 'replyFromAgent' | 'resolve'>;

export interface ReviewLanguageModelToolDeps<Thread> {
  reviewService: LanguageModelMutationService<Thread>;
  getThread(threadId: number): Thread | undefined;
  relativePath(uri: vscode.Uri): string;
  startLine(thread: Thread): number;
  uri(thread: Thread): vscode.Uri;
  log(message: string): void;
}

/** Register language-model review mutations with the same ReviewService used by commands and IPC. */
export function registerReviewLanguageModelTools<Thread>(
  subscriptions: vscode.Disposable[],
  deps: ReviewLanguageModelToolDeps<Thread>,
): void {
  if (!vscode.lm?.registerTool) return;
  subscriptions.push(
    vscode.lm.registerTool('diffReview_replyToComment', new ReplyToCommentTool(deps)),
    vscode.lm.registerTool('diffReview_resolveComment', new ResolveCommentTool(deps)),
    vscode.lm.registerTool('diffReview_deleteComment', new DeleteCommentTool(deps)),
  );
}

class ReplyToCommentTool<Thread> implements vscode.LanguageModelTool<ReplyParams> {
  constructor(private readonly deps: ReviewLanguageModelToolDeps<Thread>) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReplyParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { commentId: threadId, text } = options.input;
    const result = this.deps.reviewService.replyFromAgent(threadId, text);
    if (result.ok === false) return response(result.message);
    const thread = this.deps.getThread(threadId);
    if (!thread) return response(`Thread #${threadId} not found.`);
    this.deps.log(
      `[Diff Review] Comment #${threadId} updated (agent reply via LM tool${result.drifted ? ', drifted' : ''}) at ${this.deps.relativePath(this.deps.uri(thread))}:${this.deps.startLine(thread) + 1}`,
    );
    return response(
      result.drifted
        ? `Replied to comment #${threadId} as agent. Note: this thread is DRIFTED — its original location was not found, so the reply may no longer be actionable at a specific line.`
        : `Replied to comment #${threadId} as agent.`,
    );
  }
}

class ResolveCommentTool<Thread> implements vscode.LanguageModelTool<ThreadHandleParam> {
  constructor(private readonly deps: ReviewLanguageModelToolDeps<Thread>) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ThreadHandleParam>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { commentId: threadId } = options.input;
    const result = this.deps.reviewService.resolve(threadId);
    if (result.ok === false) return response(result.message);
    const thread = this.deps.getThread(threadId);
    if (!thread) return response(`Thread #${threadId} not found.`);
    this.deps.log(
      `[Diff Review] Comment #${threadId} updated (resolved via LM tool${result.drifted ? ', drifted' : ''}) at ${this.deps.relativePath(this.deps.uri(thread))}`,
    );
    return response(`Comment #${threadId} resolved.`);
  }
}

class DeleteCommentTool<Thread> implements vscode.LanguageModelTool<ThreadHandleParam> {
  constructor(private readonly deps: ReviewLanguageModelToolDeps<Thread>) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ThreadHandleParam>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { commentId: threadId } = options.input;
    const thread = this.deps.getThread(threadId);
    const result = this.deps.reviewService.delete(threadId);
    if (result.ok === false || !thread)
      return response(result.ok === false ? result.message : `Thread #${threadId} not found.`);
    this.deps.log(
      `[Diff Review] Comment #${threadId} deleted via LM tool${result.drifted ? ' (drifted)' : ''} at ${this.deps.relativePath(this.deps.uri(thread))}`,
    );
    return response(`Comment #${threadId} deleted.`);
  }
}

function response(message: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}
