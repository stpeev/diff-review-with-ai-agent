import * as fs from 'node:fs';
import { emptyBranch, type BranchState } from '../src/comment-store';
import { commitBranchState } from '../src/storage/branch-commit';
import { ScopeRepository } from '../src/storage/repository';

async function main(): Promise<void> {
  const [filePath, writerId, operation, body] = process.argv.slice(2);
  if (!filePath || !writerId || !operation || !body)
    throw new Error('Expected file path, writer ID, operation, and comment body.');

  const repository = new ScopeRepository();
  const baseline = repository.read(filePath, writerId);
  const branch = baseline.branches.main ?? emptyBranch();
  const timestamp = writerId === 'writer-a' ? '2026-09-13T00:00:01.000Z' : '2026-09-13T00:00:02.000Z';
  const nextBranch = nextBranchFor(operation, branch, writerId, body, timestamp);
  process.stdout.write('ready\n');
  const startPath = `${filePath}.start`;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(startPath)) return;
      clearInterval(timer);
      resolve();
    }, 5);
  });

  await repository.commit(filePath, writerId, (onDisk) => {
    return commitBranchState({
      onDisk,
      lastKnownFile: baseline,
      lastLoadedRevision: baseline.revision,
      branchKey: 'main',
      branch: nextBranch,
      writerId,
    });
  });
}

function nextBranchFor(
  operation: string,
  branch: BranchState,
  writerId: string,
  body: string,
  timestamp: string,
): BranchState {
  if (operation === 'create') {
    const threadId = branch.nextThreadId;
    const commentId = branch.nextCommentId;
    return {
      ...branch,
      nextThreadId: threadId + 1,
      nextCommentId: commentId + 1,
      threads: [
        ...branch.threads,
        {
          id: threadId,
          stableId: `${writerId}-thread`,
          uri: 'file:///workspace/example.ts',
          startLine: 0,
          endLine: 0,
          status: 'open',
          comments: [
            {
              id: commentId,
              stableId: `${writerId}-comment`,
              role: 'user',
              body,
              timestamp,
            },
          ],
          updatedAt: timestamp,
        },
      ],
    };
  }
  const thread = branch.threads[0];
  if (!thread) throw new Error(`Cannot ${operation} without a thread.`);
  if (operation === 'reply') {
    const commentId = branch.nextCommentId;
    return {
      ...branch,
      nextCommentId: commentId + 1,
      threads: branch.threads.map((current) =>
        current.id === thread.id
          ? {
              ...current,
              comments: [
                ...current.comments,
                { id: commentId, stableId: `${writerId}-reply`, role: 'agent', body, timestamp },
              ],
              updatedAt: timestamp,
            }
          : current,
      ),
    };
  }
  if (operation === 'edit') {
    return {
      ...branch,
      threads: branch.threads.map((current) =>
        current.id === thread.id
          ? {
              ...current,
              comments: current.comments.map((comment, index) => (index === 0 ? { ...comment, body } : comment)),
              updatedAt: timestamp,
            }
          : current,
      ),
    };
  }
  if (operation === 'delete') {
    return {
      ...branch,
      threads: branch.threads.filter((current) => current.id !== thread.id),
      deletedThreads: [...(branch.deletedThreads ?? []), { id: thread.id, deletedAt: timestamp }],
    };
  }
  throw new Error(`Unknown operation: ${operation}`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
