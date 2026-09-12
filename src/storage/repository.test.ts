import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { emptyScopeFile } from '../comment-store';
import { ScopeLockBusyError, ScopeRepository } from './repository';

function temporaryFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-store-')), 'comments.json');
}

function startRepositoryWriter(
  file: string,
  writerId: string,
  operation: 'create' | 'reply' | 'edit' | 'delete',
  body: string,
): { ready: Promise<void>; complete: Promise<void> } {
  const worker = path.join(process.cwd(), 'test', 'repository-worker.ts');
  const viteNode = path.join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');
  const child = spawn(
    process.execPath,
    [viteNode, '--config', 'vitest.config.ts', worker, file, writerId, operation, body],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let error = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    error += chunk.toString();
  });
  const complete = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Repository writer ${writerId} exited with ${code}: ${error}`));
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', (chunk: Buffer) => {
      if (chunk.toString() === 'ready\n') resolve();
      else reject(new Error(`Repository writer ${writerId} did not become ready: ${chunk.toString()}`));
    });
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Repository writer ${writerId} exited before becoming ready: ${error}`));
    });
  });
  return { ready, complete };
}

async function runCompetingWriters(
  file: string,
  firstOperation: 'create' | 'reply' | 'edit' | 'delete',
  secondOperation: 'create' | 'reply' | 'edit' | 'delete',
): Promise<void> {
  const first = startRepositoryWriter(file, 'writer-a', firstOperation, 'first review');
  const second = startRepositoryWriter(file, 'writer-b', secondOperation, 'second review');
  await Promise.all([first.ready, second.ready]);
  fs.writeFileSync(`${file}.start`, 'commit');
  await Promise.all([first.complete, second.complete]);
}

function writeScopeWithOneThread(file: string): void {
  const scope = emptyScopeFile('seed');
  scope.branches.main = {
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      {
        id: 1,
        stableId: 'seed-thread',
        uri: 'file:///workspace/example.ts',
        startLine: 0,
        endLine: 0,
        status: 'open',
        comments: [
          {
            id: 1,
            stableId: 'seed-comment',
            role: 'user',
            body: 'Original review',
            timestamp: '2026-09-13T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-09-13T00:00:00.000Z',
      },
    ],
  };
  new ScopeRepository().writeAtomic(file, JSON.stringify(scope));
}

test('ScopeRepository initializes only a missing file', () => {
  expect(new ScopeRepository().read(temporaryFile(), 'writer-a')).toEqual(emptyScopeFile('writer-a'));
});

test('ScopeRepository backfills stable identities when loading a legacy scope', () => {
  const file = temporaryFile();
  const legacy = emptyScopeFile('writer');
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
        comments: [{ id: 1, role: 'user', body: 'Review', timestamp: '2026-01-01T00:00:00.000Z' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  new ScopeRepository().writeAtomic(file, JSON.stringify(legacy));

  const loaded = new ScopeRepository().read(file, 'reader').branches.main.threads[0];
  expect(loaded.stableId).toBeTruthy();
  expect(loaded.comments[0].stableId).toBeTruthy();
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(3);
  expect(JSON.parse(fs.readFileSync(`${file}.v2-backup`, 'utf8')).version).toBe(2);
  const backup = fs.readFileSync(`${file}.v2-backup`, 'utf8');
  new ScopeRepository().read(file, 'reader-again');
  expect(fs.readFileSync(`${file}.v2-backup`, 'utf8')).toBe(backup);
});

test('ScopeRepository persists backfilled stable identities on the next commit', async () => {
  const file = temporaryFile();
  const legacy = emptyScopeFile('writer');
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
        comments: [{ id: 1, role: 'user', body: 'Review', timestamp: '2026-01-01T00:00:00.000Z' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  new ScopeRepository().writeAtomic(file, JSON.stringify(legacy));
  const repository = new ScopeRepository();
  await repository.commit(file, 'writer', (current) => ({ ...current, revision: current.revision + 1 }));

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(persisted.branches.main.threads[0].stableId).toBeTruthy();
  expect(persisted.branches.main.threads[0].comments[0].stableId).toBeTruthy();
});

test('ScopeRepository initializes a missing scope under its transaction lock without replacing an existing scope', () => {
  const file = temporaryFile();
  const repository = new ScopeRepository();
  const initial = emptyScopeFile('legacy-writer');

  expect(repository.initializeIfMissing(file, () => initial)).toBe(true);
  expect(repository.read(file, 'reader')).toEqual(initial);
  expect(repository.initializeIfMissing(file, () => emptyScopeFile('replacement'))).toBe(false);
  expect(repository.read(file, 'reader')).toEqual(initial);
});

test('ScopeRepository validates an initial scope before writing it', () => {
  const file = temporaryFile();
  const repository = new ScopeRepository();

  expect(() => repository.initializeIfMissing(file, () => ({ ...emptyScopeFile('writer'), revision: -1 }))).toThrow(
    'Invalid comments storage',
  );
  expect(fs.existsSync(file)).toBe(false);
});

test('ScopeRepository rejects malformed content and writes atomically', () => {
  const file = temporaryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const repository = new ScopeRepository();

  expect(() => repository.read(file, 'writer-a')).toThrow('Could not load comments');

  const value = emptyScopeFile('writer-a');
  repository.writeAtomic(file, JSON.stringify(value));
  expect(repository.read(file, 'writer-b')).toEqual(value);
  expect(fs.existsSync(`${file}.tmp-${process.pid}`)).toBe(false);
});

test('ScopeRepository commit keeps malformed files intact and does not invoke a replacement operation', async () => {
  const file = temporaryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const operation = vi.fn(() => emptyScopeFile('writer-a'));

  await expect(new ScopeRepository().commit(file, 'writer-a', operation)).rejects.toThrow('Could not load comments');
  expect(operation).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, 'utf-8')).toBe('{not json');
});

test('ScopeRepository commit reads, transforms, and writes one scope transaction', async () => {
  const file = temporaryFile();
  const repository = new ScopeRepository();

  const committed = await repository.commit(file, 'writer-a', (current) => ({
    ...current,
    revision: current.revision + 1,
  }));
  expect(committed.revision).toBe(1);
  expect(repository.read(file, 'writer-b')).toEqual(committed);
});

test('ScopeRepository commit rejects an invalid transformed record before replacing existing data', async () => {
  const file = temporaryFile();
  const repository = new ScopeRepository();
  const original = emptyScopeFile('writer-a');
  repository.writeAtomic(file, JSON.stringify(original));

  await expect(repository.commit(file, 'writer-a', (current) => ({ ...current, revision: -1 }))).rejects.toThrow(
    'Invalid comments storage',
  );
  expect(repository.read(file, 'writer-a')).toEqual(original);
});

test('ScopeRepository prevents an overlapping transaction and recovers stale locks', () => {
  const file = temporaryFile();
  const repository = new ScopeRepository();

  repository.withLock(file, (): void => {
    expect(() => repository.withLock(file, (): void => undefined)).toThrow(ScopeLockBusyError);
  });

  fs.writeFileSync(`${file}.lock`, 'stale');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(`${file}.lock`, old, old);
  expect(repository.withLock(file, () => 'saved', 60_000)).toBe('saved');
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

test('ScopeRepository does not reclaim an old lock that belongs to a live process', () => {
  const file = temporaryFile();
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live-owner' }));
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockPath, old, old);

  expect(() => new ScopeRepository().withLock(file, (): void => undefined, 60_000)).toThrow(ScopeLockBusyError);
  expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8'))).toMatchObject({ token: 'live-owner' });
});

test('ScopeRepository never releases a lock replaced by another owner', () => {
  const file = temporaryFile();
  const lockPath = `${file}.lock`;
  const repository = new ScopeRepository();

  repository.withLock(file, () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 123, token: 'other-owner' }));
  });

  expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8'))).toMatchObject({ token: 'other-owner' });
});

test('ScopeRepository respects a lock held by another process', async () => {
  const file = temporaryFile();
  const lockPath = `${file}.lock`;
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const lockPath = process.argv[1];',
        'fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
        "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'child-owner' }), { flag: 'wx' });",
        "process.stdout.write('locked\\n');",
        "process.on('SIGTERM', () => { fs.unlinkSync(lockPath); process.exit(0); });",
        'setInterval(() => undefined, 1_000);',
      ].join(' '),
      lockPath,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  try {
    await once(child.stdout!, 'data');
    expect(() => new ScopeRepository().withLock(file, (): void => undefined)).toThrow(ScopeLockBusyError);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

test('ScopeRepository completes a transaction after a competing process releases its lock', async () => {
  const file = temporaryFile();
  const lockPath = `${file}.lock`;
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const lockPath = process.argv[1];',
        'fs.mkdirSync(path.dirname(lockPath), { recursive: true });',
        "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'child-owner' }), { flag: 'wx' });",
        "process.stdout.write('locked\\n');",
        "process.on('SIGTERM', () => { fs.unlinkSync(lockPath); process.exit(0); });",
        'setInterval(() => undefined, 1_000);',
      ].join(' '),
      lockPath,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  try {
    await once(child.stdout!, 'data');
    const saved = new ScopeRepository().withRetryingLock(file, () => 'saved', {
      timeoutMs: 1_000,
      retryDelayMs: 10,
    });
    const exited = once(child, 'exit');
    setTimeout(() => child.kill('SIGTERM'), 50);
    await expect(saved).resolves.toBe('saved');
    await exited;
  } finally {
    if (!child.killed) child.kill('SIGTERM');
  }
});

test('ScopeRepository retains simultaneous writes from two real processes', async () => {
  const file = temporaryFile();
  await runCompetingWriters(file, 'create', 'create');

  const scope = new ScopeRepository().read(file, 'reader');
  const threads = scope.branches.main?.threads ?? [];
  expect(threads).toHaveLength(2);
  expect(threads.map((thread) => thread.comments[0]?.body).sort()).toEqual(['first review', 'second review']);
  expect(new Set(threads.map((thread) => thread.id)).size).toBe(2);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

test('ScopeRepository retains simultaneous replies from two real processes', async () => {
  const file = temporaryFile();
  writeScopeWithOneThread(file);
  await runCompetingWriters(file, 'reply', 'reply');

  const comments = new ScopeRepository().read(file, 'reader').branches.main?.threads[0]?.comments ?? [];
  expect(comments.map((comment) => comment.body).sort()).toEqual(['Original review', 'first review', 'second review']);
  expect(new Set(comments.map((comment) => comment.id)).size).toBe(3);
});

test('ScopeRepository retains both conflicting concurrent comment edits', async () => {
  const file = temporaryFile();
  writeScopeWithOneThread(file);
  await runCompetingWriters(file, 'edit', 'edit');

  const comments = new ScopeRepository().read(file, 'reader').branches.main?.threads[0]?.comments ?? [];
  expect(comments.map((comment) => comment.body).sort()).toEqual(['first review', 'second review']);
  expect(new Set(comments.map((comment) => comment.id)).size).toBe(2);
});

test('ScopeRepository keeps a newer concurrent deletion tombstone over an older reply', async () => {
  const file = temporaryFile();
  writeScopeWithOneThread(file);
  await runCompetingWriters(file, 'reply', 'delete');

  const branch = new ScopeRepository().read(file, 'reader').branches.main;
  expect(branch?.threads).toEqual([]);
  expect(branch?.deletedThreads).toEqual([{ id: 1, deletedAt: '2026-09-13T00:00:02.000Z' }]);
});
