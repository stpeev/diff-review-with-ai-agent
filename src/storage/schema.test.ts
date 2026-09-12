import { expect, test } from 'vitest';
import { emptyScopeFile } from '../comment-store';
import { parseScopeFile, ScopeFileValidationError } from './schema';

test('parseScopeFile accepts the complete current storage shape', () => {
  const file = emptyScopeFile('writer-a');
  file.branches.main = { nextThreadId: 2, nextCommentId: 2, threads: [] };

  expect(parseScopeFile(file)).toEqual(file);
});

test('parseScopeFile rejects partial and future storage instead of treating it as empty', () => {
  expect(() => parseScopeFile({ version: 2, branches: {} })).toThrow(ScopeFileValidationError);
  expect(() => parseScopeFile({ version: 4, revision: 0, writerId: 'w', branches: {} })).toThrow(
    'Unsupported comments storage version: 4.',
  );
});

test('parseScopeFile requires stable identities in version 3 while retaining version 2 migration input', () => {
  const legacy = emptyScopeFile('writer-a');
  legacy.version = 2;
  legacy.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      {
        id: 1,
        uri: 'file:///workspace/a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: 'Legacy', timestamp: '2026-09-12T00:00:00.000Z' }],
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
    ],
  };
  expect(parseScopeFile(legacy)).toEqual(legacy);

  const incompleteCurrent = { ...legacy, version: 3 as const };
  expect(() => parseScopeFile(incompleteCurrent)).toThrow('Invalid version 3 comments storage:');
});

test('parseScopeFile rejects duplicate IDs and counters that would reuse them', () => {
  const file = emptyScopeFile('writer-a');
  file.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      {
        id: 1,
        uri: 'file:///workspace/a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: 'First', timestamp: '2026-09-12T00:00:00.000Z' }],
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
      {
        id: 1,
        uri: 'file:///workspace/b.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: 'Second', timestamp: '2026-09-12T00:00:00.000Z' }],
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
    ],
  };

  expect(() => parseScopeFile(file)).toThrow('Duplicate thread ID.');
});

test('parseScopeFile rejects duplicate stable thread IDs', () => {
  const file = emptyScopeFile('writer-a');
  file.branches.main = {
    nextThreadId: 3,
    nextCommentId: 3,
    threads: [
      {
        id: 1,
        stableId: 'thread-one',
        uri: 'file:///workspace/a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: 'First', timestamp: '2026-09-12T00:00:00.000Z' }],
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
      {
        id: 2,
        stableId: 'thread-one',
        uri: 'file:///workspace/b.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 2, role: 'user', body: 'Second', timestamp: '2026-09-12T00:00:00.000Z' }],
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
    ],
  };

  expect(() => parseScopeFile(file)).toThrow('Duplicate stable thread ID.');
});

test('parseScopeFile rejects duplicate stable comment IDs', () => {
  const file = emptyScopeFile('writer-a');
  file.branches.main = {
    nextThreadId: 2,
    nextCommentId: 3,
    threads: [
      {
        id: 1,
        uri: 'file:///workspace/a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [
          { id: 1, stableId: 'comment-one', role: 'user', body: 'First', timestamp: '2026-09-12T00:00:00.000Z' },
          { id: 2, stableId: 'comment-one', role: 'agent', body: 'Second', timestamp: '2026-09-12T00:01:00.000Z' },
        ],
        updatedAt: '2026-09-12T00:01:00.000Z',
      },
    ],
  };

  expect(() => parseScopeFile(file)).toThrow('Duplicate stable comment ID.');
});

test('parseScopeFile preserves a file-level note location', () => {
  const file = emptyScopeFile('writer-a');
  file.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      {
        id: 1,
        stableId: 'thread-file-note',
        uri: 'file:///workspace/a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [
          {
            id: 1,
            stableId: 'comment-file-note',
            role: 'user',
            body: 'Keep this at file level.',
            timestamp: '2026-09-12T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-09-12T00:00:00.000Z',
        fileNote: true,
      },
    ],
  };

  expect(parseScopeFile(file).branches.main.threads[0].fileNote).toBe(true);
});

test('parseScopeFile rejects incompatible file-note and drifted locations', () => {
  const file = emptyScopeFile('writer-a');
  file.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      {
        id: 1,
        uri: 'file:///workspace/a.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: 'Impossible', timestamp: '2026-09-12T00:00:00.000Z' }],
        updatedAt: '2026-09-12T00:00:00.000Z',
        drifted: true,
        fileNote: true,
      },
    ],
  };

  expect(() => parseScopeFile(file)).toThrow('A file note cannot also be drifted.');
});

test('parseScopeFile accepts legacy branches without tombstones and validates new tombstones', () => {
  const legacy = emptyScopeFile('writer-a');
  legacy.branches.main = { nextThreadId: 1, nextCommentId: 1, threads: [] };
  expect(parseScopeFile(legacy).branches.main.deletedThreads).toBeUndefined();

  const invalid = emptyScopeFile('writer-a');
  invalid.branches.main = {
    nextThreadId: 3,
    nextCommentId: 1,
    threads: [],
    deletedThreads: [
      { id: 2, deletedAt: '2026-09-12T00:00:00.000Z' },
      { id: 2, deletedAt: '2026-09-12T00:01:00.000Z' },
    ],
  };
  expect(() => parseScopeFile(invalid)).toThrow('Duplicate deleted thread ID.');
});
