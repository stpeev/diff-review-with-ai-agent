import type { Role, SerializedThread } from '../../comment-store';
import type { HydratedThreadLocation } from '../../review/thread-hydration';
import type { ReviewThreadMetadata } from '../../review/model';

export interface StoredThreadMaterializerDeps<Uri, Thread, Comment> {
  parseUri(value: string): Uri;
  createThread(uri: Uri, startLine: number, endLine: number): Thread;
  createComment(body: string, role: Role, id: number, stableId: string, createdAt: string): Comment;
  setComments(thread: Thread, comments: Comment[]): void;
  setCanReply(thread: Thread, canReply: boolean): void;
  stableCommentId(comment: { id: number; role: Role; timestamp?: string; body: string; stableId?: string }): string;
  stableThreadId(thread: SerializedThread): string;
  track(thread: Thread, id: number, metadata: ReviewThreadMetadata, stableId: string): void;
  present(thread: Thread, status: SerializedThread['status']): void;
  now(): string;
}

/** Materialize a validated persisted thread as a tracked VS Code comment view. */
export function materializeStoredThread<Uri, Thread, Comment>(
  serialized: SerializedThread,
  location: HydratedThreadLocation,
  deps: StoredThreadMaterializerDeps<Uri, Thread, Comment>,
): Thread {
  const uri = deps.parseUri(serialized.uri);
  const startLine = Math.max(0, location.startLine);
  const endLine = Math.max(startLine, location.endLine);
  const thread = deps.createThread(uri, startLine, endLine);
  deps.setComments(
    thread,
    serialized.comments.map((comment) =>
      deps.createComment(
        comment.body,
        comment.role,
        comment.id,
        deps.stableCommentId(comment),
        comment.timestamp || deps.now(),
      ),
    ),
  );
  deps.setCanReply(thread, true);
  deps.track(
    thread,
    serialized.id,
    {
      updatedAt: serialized.updatedAt,
      status: serialized.status,
      anchorHash: location.anchorHash,
      anchorContext: location.anchorContext ?? serialized.anchorContext,
      location: location.drifted
        ? { kind: 'drifted', lastKnownLine: startLine }
        : serialized.fileNote
          ? { kind: 'file-note' }
          : { kind: 'anchored', startLine, endLine },
    },
    deps.stableThreadId(serialized),
  );
  deps.present(thread, serialized.status);
  return thread;
}
