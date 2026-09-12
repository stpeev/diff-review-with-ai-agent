import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { backfillStableIds, emptyScopeFile, type ScopeFile } from '../comment-store';
import { parseScopeFile } from './schema';

/** Filesystem boundary for versioned comment-scope storage. */
export class ScopeRepository {
  read(filePath: string, writerId: string): ScopeFile {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (error: unknown) {
      if (isNotFound(error)) return emptyScopeFile(writerId);
      throw new Error(`Could not read comments from ${filePath}: ${messageOf(error)}`);
    }

    try {
      const parsed = parseScopeFile(JSON.parse(raw));
      if (parsed.version !== 2) return backfillStableIds(parsed);
      return this.withLock(filePath, () => this.migrateVersion2(filePath));
    } catch (error: unknown) {
      throw new Error(`Could not load comments from ${filePath}: ${messageOf(error)}`);
    }
  }

  /** Read a scope while the caller already owns its transaction lock. */
  private readWhileLocked(filePath: string, writerId: string): ScopeFile {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (error: unknown) {
      if (isNotFound(error)) return emptyScopeFile(writerId);
      throw new Error(`Could not read comments from ${filePath}: ${messageOf(error)}`);
    }

    try {
      const parsed = parseScopeFile(JSON.parse(raw));
      return parsed.version === 2 ? this.migrateVersion2(filePath) : backfillStableIds(parsed);
    } catch (error: unknown) {
      throw new Error(`Could not load comments from ${filePath}: ${messageOf(error)}`);
    }
  }

  private migrateVersion2(filePath: string): ScopeFile {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseScopeFile(JSON.parse(raw));
    if (parsed.version !== 2) return backfillStableIds(parsed);
    const backupPath = `${filePath}.v2-backup`;
    if (!fs.existsSync(backupPath)) this.writeAtomic(backupPath, raw);
    const migrated = backfillStableIds(parsed);
    this.writeAtomic(filePath, JSON.stringify(migrated));
    return migrated;
  }

  writeAtomic(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, content, 'utf-8');
    fs.renameSync(temporaryPath, filePath);
  }

  /**
   * Persist an initial scope only while it remains absent under the same
   * inter-process lock used by regular commits. This prevents a legacy import
   * from replacing a scope another window created during activation.
   */
  initializeIfMissing(filePath: string, initial: () => ScopeFile): boolean {
    return this.withLock(filePath, () => {
      try {
        fs.statSync(filePath);
        return false;
      } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
      }
      const value = parseScopeFile(initial());
      this.writeAtomic(filePath, JSON.stringify(value));
      return true;
    });
  }

  /**
   * Serialize the complete read/merge/write transaction across extension
   * processes. A lock records its owner PID and is recoverable after a crash.
   */
  withLock<T>(filePath: string, operation: () => T, staleAfterMs = 60_000): T {
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const token = this.acquireLock(lockPath, staleAfterMs);
    try {
      return operation();
    } finally {
      this.releaseLock(lockPath, token);
    }
  }

  /**
   * Wait briefly for a live writer instead of failing a save at the first
   * cross-window collision. The transaction itself remains synchronous and
   * protected by the same exclusive lock.
   */
  async withRetryingLock<T>(
    filePath: string,
    operation: () => T,
    options: { timeoutMs?: number; retryDelayMs?: number; staleAfterMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 2_000;
    const retryDelayMs = options.retryDelayMs ?? 25;
    const staleAfterMs = options.staleAfterMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return this.withLock(filePath, operation, staleAfterMs);
      } catch (error) {
        if (!(error instanceof ScopeLockBusyError) || Date.now() >= deadline) throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  /**
   * Apply one complete scope-file transaction while holding the inter-process
   * lock. Parsing happens before the caller can produce replacement content,
   * so corrupt or future-version data is never silently overwritten.
   */
  async commit(
    filePath: string,
    writerId: string,
    operation: (current: ScopeFile) => ScopeFile,
    options: { timeoutMs?: number; retryDelayMs?: number; staleAfterMs?: number } = {},
  ): Promise<ScopeFile> {
    return this.withRetryingLock(
      filePath,
      () => {
        const next = parseScopeFile(operation(this.readWhileLocked(filePath, writerId)));
        this.writeAtomic(filePath, JSON.stringify(next));
        return next;
      },
      options,
    );
  }

  private acquireLock(lockPath: string, staleAfterMs: number): string {
    const token = crypto.randomUUID();
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), {
        flag: 'wx',
      });
      return token;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw new Error(`Could not acquire comments lock: ${messageOf(error)}`);
    }

    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch (statError: unknown) {
      // The owner released the lock between our exclusive-create failure and
      // inspection. Treat it as an ordinary acquisition race and try again.
      if (isNotFound(statError)) return this.acquireLock(lockPath, staleAfterMs);
      throw statError;
    }
    if (ageMs > staleAfterMs) {
      // A long transaction can legitimately outlive the nominal stale window.
      // Prefer a live owner over reclaiming its lock; malformed legacy lock
      // files remain reclaimable after the same timeout.
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
        if (typeof lock.pid === 'number' && Number.isSafeInteger(lock.pid) && lock.pid > 0 && processExists(lock.pid)) {
          throw new ScopeLockBusyError(lockPath);
        }
      } catch (error) {
        if (error instanceof ScopeLockBusyError) throw error;
        // Invalid lock metadata is treated like an abandoned pre-owner lock.
      }
      fs.unlinkSync(lockPath);
      return this.acquireLock(lockPath, staleAfterMs);
    }
    throw new ScopeLockBusyError(lockPath);
  }

  private releaseLock(lockPath: string, token: string): void {
    try {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      const lock = JSON.parse(raw) as { token?: unknown };
      if (lock.token === token) fs.unlinkSync(lockPath);
    } catch {
      // A crash or external recovery can remove or replace the lock first.
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ScopeLockBusyError extends Error {
  constructor(lockPath: string) {
    super(`Comments are being saved by another window (${lockPath}).`);
    this.name = 'ScopeLockBusyError';
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
