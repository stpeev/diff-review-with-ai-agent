import type { ReplyAuthor, ReviewService } from '../../review/service';

export interface FileUri {
  scheme: string;
  fsPath: string;
}

export interface CommentThreadCreationDeps<Uri extends FileUri, Range, Thread> {
  fileExists(filePath: string): boolean;
  readTextFile(filePath: string): string;
  displayPath(uri: Uri): string;
  createRange(startLine: number, endLine: number): Range;
  createThread(uri: Uri, range: Range): Thread;
  disposeThread(thread: Thread): void;
  reviewService: ReviewService<Thread>;
}

export type CreateCommentThreadResult = { threadId: number } | { error: string };

/**
 * Validate an external file/range request before adapting it to a VS Code
 * thread. The service remains the sole owner of review-comment mutation.
 */
export function createCommentThreadAt<Uri extends FileUri, Range, Thread>(
  deps: CommentThreadCreationDeps<Uri, Range, Thread>,
  uri: Uri,
  startLine: number,
  endLine: number,
  text: string,
  author: ReplyAuthor = 'agent',
): CreateCommentThreadResult {
  if (uri.scheme !== 'file' || !deps.fileExists(uri.fsPath)) return { error: `File not found: ${uri.fsPath}` };

  const lineCount = deps.readTextFile(uri.fsPath).split(/\r\n|\n/).length;
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 0 ||
    endLine < startLine ||
    endLine >= lineCount
  ) {
    return { error: `Line out of range for ${deps.displayPath(uri)} (file has ${lineCount} line(s)).` };
  }

  const thread = deps.createThread(uri, deps.createRange(startLine, endLine));
  const created = deps.reviewService.create(thread, text, author);
  if (created.ok === false) {
    deps.disposeThread(thread);
    return { error: created.message };
  }
  return { threadId: created.threadId };
}
