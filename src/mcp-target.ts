import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  AmbiguousPortError,
  descriptorDir,
  type Descriptor,
  NoServerError,
  resolvePort,
  type ResolveResult,
} from './ipc-discovery';
import { getIpcJson, IpcHttpError, postIpcJson } from './protocol/client';

export interface TargetResolverDependencies {
  listDescriptors(): Descriptor[];
  ping(port: number, endpoint: string): Promise<boolean>;
  readLegacyPort(): number | undefined;
  portFlag: number | undefined;
  cwd: string;
  log(message: string): void;
}

export type TargetChangeListener = (next: ResolveResult, previous: ResolveResult) => void;

export interface TargetResolver {
  /** The saved target, running first-connection discovery only when none is saved. */
  current(): Promise<ResolveResult>;
  /** Run discovery again under the same-root rule. Returns undefined while the saved window has not come back. */
  rescan(): Promise<ResolveResult | undefined>;
  /** Run discovery with the first-connection rules, replacing any saved root. */
  reconnect(): Promise<ResolveResult>;
  /** Make the next `current()` re-scan first. */
  markStale(): void;
  saved(): ResolveResult | undefined;
  /** True while a re-scan has failed to find the saved window. */
  isHeld(): boolean;
  /** Why the saved window is unavailable, for tool results. */
  unavailableError(): Error;
  /** Fires when a re-scan or reconnect moves to a different port. */
  onTargetChanged(listener: TargetChangeListener): void;
}

export class WaitingForWindowError extends Error {
  constructor(public readonly root: string) {
    super(
      `Waiting for the VS Code window for ${root} to come back. ` +
        'Run /register-for-diff-review-send to connect to a different window.',
    );
    this.name = 'WaitingForWindowError';
  }
}

export function createTargetResolver(dependencies: TargetResolverDependencies): TargetResolver {
  let target: ResolveResult | undefined;
  let stale = false;
  let held = false;
  let lastError: Error | undefined;
  const listeners: TargetChangeListener[] = [];

  async function discover(): Promise<ResolveResult> {
    if (dependencies.portFlag !== undefined) {
      return { port: dependencies.portFlag, matchedRoot: null, source: 'flag' };
    }
    const candidates = dependencies.listDescriptors();
    const checks = await Promise.all(candidates.map((candidate) => dependencies.ping(candidate.port, '/ping')));
    try {
      return resolvePort(
        candidates.filter((_, index) => checks[index]),
        { cwd: dependencies.cwd },
      );
    } catch (error) {
      if (error instanceof AmbiguousPortError) throw error;
      if (!(error instanceof NoServerError)) throw error;
    }
    const legacy = dependencies.readLegacyPort();
    if (legacy !== undefined && (await dependencies.ping(legacy, '/health'))) {
      dependencies.log(
        'Warning: resolved via the deprecated global port file. ' +
          'If multiple VS Code windows are open, this may be the wrong one. Update the extension to fix this.',
      );
      return { port: legacy, matchedRoot: null, source: 'sole-live' };
    }
    throw new NoServerError();
  }

  function accept(next: ResolveResult): void {
    const previous = target;
    target = next;
    stale = false;
    held = false;
    lastError = undefined;
    if (!previous || previous.port === next.port) return;
    dependencies.log(`Connected to the VS Code window on port ${next.port} (was ${previous.port})`);
    for (const listener of listeners) {
      try {
        listener(next, previous);
      } catch (error: any) {
        dependencies.log(`Target change listener failed: ${error?.message ?? error}`);
      }
    }
  }

  function hold(error: Error): undefined {
    lastError = error;
    held = target !== undefined;
    dependencies.log(`Re-scan did not find the saved window: ${error.message}`);
    return undefined;
  }

  async function rescan(): Promise<ResolveResult | undefined> {
    let next: ResolveResult;
    try {
      next = await discover();
    } catch (error: any) {
      return hold(error);
    }
    if (target?.source === 'cwd-match' && !(next.source === 'cwd-match' && next.matchedRoot === target.matchedRoot)) {
      return hold(
        new Error(`found port ${next.port} (${next.matchedRoot ?? 'no root'}) instead of ${target.matchedRoot}`),
      );
    }
    accept(next);
    return next;
  }

  function unavailableError(): Error {
    if (target?.source === 'cwd-match' && target.matchedRoot) return new WaitingForWindowError(target.matchedRoot);
    return lastError ?? new NoServerError();
  }

  return {
    async current() {
      if (!target) {
        const next = await discover();
        accept(next);
        return next;
      }
      if (stale || held) {
        const next = await rescan();
        if (!next) throw unavailableError();
        return next;
      }
      return target;
    },
    rescan,
    async reconnect() {
      const next = await discover();
      accept(next);
      return next;
    },
    markStale() {
      stale = true;
    },
    saved: () => target,
    isHeld: () => held,
    unavailableError,
    onTargetChanged(listener) {
      listeners.push(listener);
    },
  };
}

export interface McpTargetTransport {
  get<T>(endpoint: string, target: ResolveResult, timeoutMs?: number): Promise<T>;
  post<T>(endpoint: string, target: ResolveResult, data: object): Promise<T>;
}

export interface McpTargetClient {
  post<T = unknown>(endpoint: string, data: object): Promise<T>;
  get<T = unknown>(endpoint: string, timeoutMs?: number): Promise<T>;
}

function isConnectionRefused(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED';
}

/**
 * Sends requests to the resolver's target. A refused connection never reached
 * a server, so it is repeated once on a new port. Any other failure after
 * connecting may have been handled already (`/create` is not idempotent), so it
 * is never repeated; it only makes the next call re-scan first.
 */
export function createMcpTargetClient(
  resolver: TargetResolver,
  transport: McpTargetTransport = { get: getIpcJson, post: postIpcJson },
): McpTargetClient {
  async function send<T>(call: (target: ResolveResult) => Promise<T>): Promise<T> {
    const target = await resolver.current();
    try {
      return await call(target);
    } catch (error) {
      if (isConnectionRefused(error)) {
        const next = await resolver.rescan();
        if (!next) throw resolver.isHeld() ? resolver.unavailableError() : error;
        if (next.port === target.port) throw error;
        return call(next);
      }
      if (!(error instanceof IpcHttpError) || error.status === 409) resolver.markStale();
      throw error;
    }
  }

  return {
    post: (endpoint, data) => send((target) => transport.post(endpoint, target, data)),
    get: (endpoint, timeoutMs) => send((target) => transport.get(endpoint, target, timeoutMs)),
  };
}

function portFlag(): number | undefined {
  const index = process.argv.indexOf('--port');
  return index !== -1 && process.argv[index + 1] ? Number.parseInt(process.argv[index + 1], 10) : undefined;
}

function descriptors(tmpDir: string): Descriptor[] {
  try {
    return fs
      .readdirSync(descriptorDir(tmpDir))
      .filter((entry) => entry.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const value = JSON.parse(fs.readFileSync(path.join(descriptorDir(tmpDir), entry), 'utf-8'));
          return typeof value.port === 'number' ? [value as Descriptor] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function ping(port: number, endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}${endpoint}`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(800, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function readLegacyPort(): number | undefined {
  try {
    const legacy = Number.parseInt(fs.readFileSync(path.join(os.tmpdir(), 'diff-review-port'), 'utf-8').trim(), 10);
    return Number.isSafeInteger(legacy) ? legacy : undefined;
  } catch {
    // The legacy pointer is optional during the migration grace period.
    return undefined;
  }
}

/** The resolver for this MCP process, wired to the real filesystem, network and environment. */
export const mcpTargetResolver = createTargetResolver({
  listDescriptors: () => descriptors(os.tmpdir()),
  ping,
  readLegacyPort,
  portFlag: portFlag(),
  cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  log: (message) => process.stderr.write(`[diff-review] ${message}\n`),
});

const mcpTargetClient = createMcpTargetClient(mcpTargetResolver);

/** Discover and cache the extension IPC target for this MCP process. */
export function resolveMcpTarget(): Promise<ResolveResult> {
  return mcpTargetResolver.current();
}

export function postToMcpTarget<T = unknown>(endpoint: string, data: object): Promise<T> {
  return mcpTargetClient.post<T>(endpoint, data);
}

export function getFromMcpTarget<T = unknown>(endpoint: string, timeoutMs?: number): Promise<T> {
  return mcpTargetClient.get<T>(endpoint, timeoutMs);
}
