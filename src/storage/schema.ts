import { z } from 'zod';
import type { ScopeFile } from '../comment-store';

const commentSchema = z.object({
  id: z.number().int().positive(),
  stableId: z.string().min(1).optional(),
  role: z.enum(['user', 'agent']),
  body: z.string(),
  timestamp: z.string(),
});

const deletedThreadSchema = z.object({
  id: z.number().int().positive(),
  deletedAt: z.string(),
});

const threadSchema = z
  .object({
    id: z.number().int().positive(),
    stableId: z.string().min(1).optional(),
    uri: z.string(),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    status: z.enum(['open', 'resolved']),
    comments: z.array(commentSchema),
    updatedAt: z.string(),
    anchorHash: z.string().optional(),
    anchorContext: z.string().optional(),
    drifted: z.boolean().optional(),
    fileNote: z.boolean().optional(),
  })
  .superRefine((thread, context) => {
    if (thread.drifted && thread.fileNote) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fileNote'],
        message: 'A file note cannot also be drifted.',
      });
    }
  });

const branchSchema = z
  .object({
    nextThreadId: z.number().int().positive(),
    nextCommentId: z.number().int().positive(),
    threads: z.array(threadSchema),
    deletedThreads: z.array(deletedThreadSchema).optional(),
  })
  .superRefine((branch, context) => {
    const threadIds = new Set<number>();
    const stableThreadIds = new Set<string>();
    const deletedThreadIds = new Set<number>();
    const commentIds = new Set<number>();
    const stableCommentIds = new Set<string>();
    let maxThreadId = 0;
    let maxCommentId = 0;
    for (const [threadIndex, thread] of branch.threads.entries()) {
      maxThreadId = Math.max(maxThreadId, thread.id);
      if (threadIds.has(thread.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['threads', threadIndex, 'id'],
          message: 'Duplicate thread ID.',
        });
      }
      threadIds.add(thread.id);
      if (thread.stableId) {
        if (stableThreadIds.has(thread.stableId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['threads', threadIndex, 'stableId'],
            message: 'Duplicate stable thread ID.',
          });
        }
        stableThreadIds.add(thread.stableId);
      }
      for (const [commentIndex, comment] of thread.comments.entries()) {
        maxCommentId = Math.max(maxCommentId, comment.id);
        if (commentIds.has(comment.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['threads', threadIndex, 'comments', commentIndex, 'id'],
            message: 'Duplicate comment ID.',
          });
        }
        commentIds.add(comment.id);
        if (comment.stableId) {
          if (stableCommentIds.has(comment.stableId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['threads', threadIndex, 'comments', commentIndex, 'stableId'],
              message: 'Duplicate stable comment ID.',
            });
          }
          stableCommentIds.add(comment.stableId);
        }
      }
    }
    for (const [deletedIndex, deleted] of (branch.deletedThreads ?? []).entries()) {
      if (deletedThreadIds.has(deleted.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deletedThreads', deletedIndex, 'id'],
          message: 'Duplicate deleted thread ID.',
        });
      }
      deletedThreadIds.add(deleted.id);
      maxThreadId = Math.max(maxThreadId, deleted.id);
    }
    if (branch.nextThreadId <= maxThreadId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextThreadId'],
        message: 'nextThreadId must exceed every thread ID.',
      });
    }
    if (branch.nextCommentId <= maxCommentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextCommentId'],
        message: 'nextCommentId must exceed every comment ID.',
      });
    }
  });

const scopeFileSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  revision: z.number().int().nonnegative(),
  writerId: z.string().min(1),
  branches: z.record(z.string(), branchSchema),
});

function requireVersion3StableIds(file: ScopeFile): void {
  if (file.version !== 3) return;

  for (const [branchName, branch] of Object.entries(file.branches)) {
    for (const thread of branch.threads) {
      if (!thread.stableId) {
        throw new ScopeFileValidationError(
          `Invalid version 3 comments storage: thread ${thread.id} in branch ${branchName} has no stable ID.`,
        );
      }
      for (const [commentIndex, comment] of thread.comments.entries()) {
        if (!comment.stableId) {
          throw new ScopeFileValidationError(
            `Invalid version 3 comments storage: comment ${comment.id} at position ${commentIndex + 1} in thread ${thread.id} of branch ${branchName} has no stable ID.`,
          );
        }
      }
    }
  }
}

export class ScopeFileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeFileValidationError';
  }
}

/** Parse supported storage without silently accepting partial data. */
export function parseScopeFile(value: unknown): ScopeFile {
  if (typeof value === 'object' && value !== null && 'version' in value) {
    const version = (value as { version?: unknown }).version;
    if (version !== 2 && version !== 3) {
      throw new ScopeFileValidationError(`Unsupported comments storage version: ${String(version)}.`);
    }
  }

  const parsed = scopeFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new ScopeFileValidationError(
      `Invalid comments storage: ${parsed.error.issues[0]?.message ?? 'unknown schema error'}.`,
    );
  }
  const file = parsed.data as ScopeFile;
  requireVersion3StableIds(file);
  return file;
}
