import { expect, test, vi } from 'vitest';

const tools = new Map<
  string,
  { invoke(options: { input: unknown }, token: unknown): Promise<{ content: unknown[] }> }
>();

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ path }) },
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

import {
  registerReviewLanguageModelQueryTools,
  renderLanguageModelReviewList,
} from './review-language-model-query-tools';

function registeredTools() {
  tools.clear();
  const createComment = vi.fn(() => ({ threadId: 7 }));
  const log = vi.fn();
  registerReviewLanguageModelQueryTools([], {
    resolveWorkspacePath: (path) => `/workspace/${path}`,
    createComment,
    listEntries: () => [
      { id: 7, path: 'src/example.ts', status: 'open', line: 3, comments: [{ role: 'user', text: 'Review this.' }] },
    ],
    driftedCount: () => 0,
    log,
  });
  return { createComment, log };
}

function text(result: { content: Array<{ value: string }> }): string {
  return result.content[0]!.value;
}

test('create LM tool resolves a workspace path and converts external lines once', async () => {
  const { createComment, log } = registeredTools();

  const result = (await tools
    .get('diffReview_createComment')!
    .invoke({ input: { path: 'src/example.ts', line: 7, endLine: 8, text: 'Review this.' } }, undefined)) as never as {
    content: Array<{ value: string }>;
  };

  expect(createComment).toHaveBeenCalledWith({ path: '/workspace/src/example.ts' }, 6, 7, 'Review this.');
  expect(text(result)).toBe('Created comment thread #7 at src/example.ts:7.');
  expect(log).toHaveBeenCalledWith('Comment #7 created via LM tool at src/example.ts:7');
});

test('list LM tool renders review data from plain entry DTOs', async () => {
  registeredTools();

  const result = (await tools.get('diffReview_listComments')!.invoke({ input: {} }, undefined)) as never as {
    content: Array<{ value: string }>;
  };

  expect(text(result)).toBe('#7 | src/example.ts:4 | OPEN\n  [user] Review this.');
});

test('list rendering preserves drifted locations instead of treating them as actionable lines', () => {
  expect(
    renderLanguageModelReviewList([
      {
        id: 3,
        path: 'src/example.ts',
        status: 'resolved',
        driftedLine: 9,
        comments: [{ role: 'agent', text: 'Fixed.' }],
      },
    ]),
  ).toBe('#3 | DRIFTED (was src/example.ts:10) | RESOLVED\n  [agent] Fixed.');
});
