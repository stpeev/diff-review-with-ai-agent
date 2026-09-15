import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { ReviewWaiters } from '../../protocol/review-waiters';
import { createIpcRequestHandler } from './ipc-request-handler';

function response() {
  const result = {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return result;
}

function handler(overrides: { body?: string; readBody?: () => Promise<string>; reviewService?: object } = {}) {
  return createIpcRequestHandler({
    reads: {
      workspaceRoots: () => ['/workspace'],
      processId: () => 10,
      comments: () => [{ id: 1 }],
      health: () => ({ comments: 1 }),
    },
    sessions: {
      workspaceMatches: () => true,
      cwdInWorkspace: () => true,
      clearBoundSession: async () => undefined,
      verifyClaudeSession: () => true,
      claudePidFromSocketPath: () => undefined,
      sessions: {
        get: () => undefined,
        remove: () => undefined,
        register: () => ({}) as never,
        list: () => [],
      },
      log: () => undefined,
    },
    mutations: {
      workspaceMatches: () => true,
      reviewService: (overrides.reviewService ?? {}) as never,
      threadLocation: () => undefined,
    },
    creates: {
      workspaceMatches: () => false,
      resolvePath: () => '/workspace/file.ts',
      createComment: () => ({ threadId: 1 }),
    },
    waiters: new ReviewWaiters(),
    readBody:
      overrides.readBody ??
      (async () =>
        overrides.body ??
        JSON.stringify({ path: 'file.ts', line: 1, text: 'Review this', expectWorkspaceRoot: '/other' })),
    workspaceRoots: () => ['/workspace'],
    log: vi.fn(),
  });
}

test('serializes a read route and applies shared HTTP response headers', async () => {
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/comments' });
  const result = response();

  await handler()(request as never, result as never);

  expect(result.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  expect(result.writeHead).toHaveBeenCalledWith(200);
  expect(result.end).toHaveBeenCalledWith(JSON.stringify({ threads: [{ id: 1 }] }));
});

test('routes an agent reply through the shared review service and logs its location', async () => {
  const replyFromAgent = vi.fn(() => ({ ok: true, commentId: 2, drifted: false }));
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/reply' });
  const result = response();

  await handler({
    body: JSON.stringify({ threadId: 1, text: 'Addressed', expectWorkspaceRoot: '/workspace' }),
    reviewService: { replyFromAgent },
  })(request as never, result as never);

  expect(replyFromAgent).toHaveBeenCalledWith(1, 'Addressed');
  expect(result.writeHead).toHaveBeenCalledWith(200);
  expect(result.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, commentId: 2 }));
});

test('maps malformed request bodies and unknown routes to transport errors', async () => {
  const invalidRequest = Object.assign(new EventEmitter(), { method: 'POST', url: '/create' });
  const invalidResult = response();
  await handler({ readBody: async () => Promise.reject(new Error('bad body')) })(
    invalidRequest as never,
    invalidResult as never,
  );
  expect(invalidResult.writeHead).toHaveBeenCalledWith(400);
  expect(invalidResult.end).toHaveBeenCalledWith(JSON.stringify({ error: 'bad body' }));

  const missingRequest = Object.assign(new EventEmitter(), { method: 'DELETE', url: '/missing' });
  const missingResult = response();
  await handler()(missingRequest as never, missingResult as never);
  expect(missingResult.writeHead).toHaveBeenCalledWith(404);
});

test('returns the current workspace roots for a rejected mutation', async () => {
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/create' });
  const result = response();

  await handler()(request as never, result as never);

  expect(result.writeHead).toHaveBeenCalledWith(409);
  expect(result.end).toHaveBeenCalledWith(JSON.stringify({ error: 'workspace mismatch', have: ['/workspace'] }));
});
