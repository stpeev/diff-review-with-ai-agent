import { expect, test, vi } from 'vitest';

const tools = new Map<
  string,
  { invoke(options: { input: unknown }, token: unknown): Promise<{ content: unknown[] }> }
>();

vi.mock('vscode', () => ({
  lm: {
    registerTool: (name: string, tool: typeof tools extends Map<string, infer Tool> ? Tool : never) => {
      tools.set(name, tool);
      return { dispose: () => undefined };
    },
  },
  LanguageModelToolResult: class LanguageModelToolResult {
    constructor(readonly content: unknown[]) {}
  },
  LanguageModelTextPart: class LanguageModelTextPart {
    constructor(readonly value: string) {}
  },
}));

import { registerReviewLanguageModelTools } from './review-language-model-tools';

function registeredTools() {
  tools.clear();
  const thread = { uri: { path: 'src/example.ts' } as never };
  const replyFromAgent = vi.fn(() => ({ ok: true as const, commentId: 7, drifted: false }));
  const resolve = vi.fn(() => ({ ok: true as const, drifted: false }));
  const deleteThread = vi.fn(() => ({ ok: true as const, drifted: false }));
  const log = vi.fn();

  registerReviewLanguageModelTools([], {
    reviewService: { delete: deleteThread, replyFromAgent, resolve },
    getThread: (id) => (id === 42 ? thread : undefined),
    relativePath: (uri) => uri.path,
    startLine: () => 6,
    uri: (candidate) => candidate.uri,
    log,
  });

  return { deleteThread, log, replyFromAgent, resolve };
}

function text(result: { content: Array<{ value: string }> }): string {
  return result.content[0]!.value;
}

test('reply LM tool delegates to the review service and reports its result', async () => {
  const { log, replyFromAgent } = registeredTools();

  const result = (await tools
    .get('diffReview_replyToComment')!
    .invoke({ input: { commentId: 42, text: 'Addressed.' } }, undefined)) as never as {
    content: Array<{ value: string }>;
  };

  expect(replyFromAgent).toHaveBeenCalledWith(42, 'Addressed.');
  expect(text(result)).toBe('Replied to comment #42 as agent.');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('agent reply via LM tool'));
});

test('resolve and delete LM tools use the same thread handle and service', async () => {
  const { deleteThread, resolve } = registeredTools();

  await tools.get('diffReview_resolveComment')!.invoke({ input: { commentId: 42 } }, undefined);
  await tools.get('diffReview_deleteComment')!.invoke({ input: { commentId: 42 } }, undefined);

  expect(resolve).toHaveBeenCalledWith(42);
  expect(deleteThread).toHaveBeenCalledWith(42);
});

test('LM mutation tools return the service not-found result', async () => {
  const { resolve } = registeredTools();
  resolve.mockReturnValue({ ok: false, code: 'not-found', message: 'Thread #99 not found.' } as never);

  const result = (await tools
    .get('diffReview_resolveComment')!
    .invoke({ input: { commentId: 99 } }, undefined)) as never as { content: Array<{ value: string }> };

  expect(text(result)).toBe('Thread #99 not found.');
});
