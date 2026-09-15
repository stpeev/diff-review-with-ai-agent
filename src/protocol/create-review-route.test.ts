import { expect, test, vi } from 'vitest';
import { handleCreateReviewRoute } from './create-review-route';

function deps() {
  return {
    workspaceMatches: vi.fn(() => true),
    resolvePath: vi.fn((): string | { error: string } => '/workspace/src/file.ts'),
    createComment: vi.fn(() => ({ threadId: 7 })),
  };
}

test('create route validates workspace ownership before resolving a path', () => {
  const effects = deps();
  effects.workspaceMatches.mockReturnValue(false);

  expect(
    handleCreateReviewRoute(JSON.stringify({ path: 'src/file.ts', line: 1, text: 'Review this' }), effects),
  ).toEqual({
    status: 409,
    body: { error: 'workspace mismatch' },
  });
  expect(effects.resolvePath).not.toHaveBeenCalled();
});

test('create route converts external one-based lines exactly once', () => {
  const effects = deps();

  expect(
    handleCreateReviewRoute(JSON.stringify({ path: 'src/file.ts', line: 3, endLine: 5, text: 'Review this' }), effects),
  ).toEqual({ status: 200, body: { ok: true, threadId: 7 } });
  expect(effects.createComment).toHaveBeenCalledWith('/workspace/src/file.ts', 2, 4, 'Review this');
});

test('create route returns adapter validation errors without creating a thread', () => {
  const effects = deps();
  effects.resolvePath.mockReturnValue({ error: 'File not found: src/file.ts' });

  expect(
    handleCreateReviewRoute(JSON.stringify({ path: 'src/file.ts', line: 1, text: 'Review this' }), effects),
  ).toEqual({
    status: 400,
    body: { error: 'File not found: src/file.ts' },
  });
  expect(effects.createComment).not.toHaveBeenCalled();
});
