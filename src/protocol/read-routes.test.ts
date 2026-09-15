import { expect, test } from 'vitest';
import { handleIpcReadRoute } from './read-routes';

const deps = {
  workspaceRoots: () => ['/workspace'],
  processId: () => 42,
  comments: () => [{ id: 7 }],
  health: () => ({ comments: 1, drifted: 0, persistence: { pending: 0, failed: [] } }),
};

test('read routes return stable protocol DTOs', () => {
  expect(handleIpcReadRoute('/ping', deps)).toEqual({ status: 200, body: { workspaceRoots: ['/workspace'], pid: 42 } });
  expect(handleIpcReadRoute('/comments', deps)).toEqual({ status: 200, body: { threads: [{ id: 7 }] } });
  expect(handleIpcReadRoute('/health', deps)).toEqual({
    status: 200,
    body: { ok: true, comments: 1, drifted: 0, persistence: { pending: 0, failed: [] } },
  });
});

test('read routes leave unknown paths for the next protocol handler', () => {
  expect(handleIpcReadRoute('/missing', deps)).toBeUndefined();
});
