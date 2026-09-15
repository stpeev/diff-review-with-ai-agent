import { expect, test } from 'vitest';
import { buildPromptThreads } from './review-prompt-builder';

interface Uri {
  key: string;
}

interface Thread {
  uri: Uri;
  id: number;
  range: { start: { line: number }; end: { line: number } };
  comments: Array<{ role?: 'user' | 'agent'; body: string }>;
}

const uri = (key: string): Uri => ({ key });

test('buildPromptThreads groups diff retrieval by file and sorts threads by line', async () => {
  const diffRequests: string[] = [];
  const threads: Thread[] = [
    { uri: uri('a.ts'), id: 2, range: { start: { line: 7 }, end: { line: 7 } }, comments: [{ body: 'later' }] },
    {
      uri: uri('a.ts'),
      id: 1,
      range: { start: { line: 2 }, end: { line: 2 } },
      comments: [{ role: 'agent', body: 'first' }],
    },
  ];
  const result = await buildPromptThreads<Uri, Thread>(
    {
      uriKey: (value) => value.key,
      displayPath: (value) => `src/${value.key}`,
      range: (thread) => thread.range,
      threadId: (thread) => thread.id,
      diffHunks: async (value) => {
        diffRequests.push(value.key);
        return [{ header: '@@ -3 +3 @@', lines: ['-old', '+new'] }];
      },
      document: async () => ({ lineCount: 10, lineAt: (line) => ({ text: `line ${line + 1}` }) }),
    },
    threads,
  );

  expect(diffRequests).toEqual(['a.ts']);
  expect(result.map((thread) => thread.id)).toEqual([1, 2]);
  expect(result[0]).toMatchObject({
    file: 'src/a.ts',
    startLine: 2,
    comments: [{ role: 'agent', body: 'first' }],
    codeContext: '  1 | line 1\n  2 | line 2\n→ 3 | line 3\n  4 | line 4\n  5 | line 5',
    diffHunk: '@@ -3 +3 @@\n-old\n+new',
  });
});

test('buildPromptThreads still returns a prompt thread when local context cannot be opened', async () => {
  const thread: Thread = {
    uri: uri('a.ts'),
    id: 1,
    range: { start: { line: 0 }, end: { line: 0 } },
    comments: [{ body: 'review' }],
  };
  const result = await buildPromptThreads<Uri, Thread>(
    {
      uriKey: (value) => value.key,
      displayPath: (value) => value.key,
      range: (value) => value.range,
      threadId: (value) => value.id,
      diffHunks: async () => [],
      document: async () => Promise.reject(new Error('not available')),
    },
    [thread],
  );
  expect(result[0]).toMatchObject({ codeContext: undefined, comments: [{ role: 'user', body: 'review' }] });
});
