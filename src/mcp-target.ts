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
import { postIpcJson } from './protocol/client';

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

let cachedTarget: ResolveResult | undefined;

/** Discover and cache the extension IPC target for this MCP process. */
export async function resolveMcpTarget(): Promise<ResolveResult> {
  if (cachedTarget) return cachedTarget;
  const flag = portFlag();
  if (flag !== undefined) return (cachedTarget = { port: flag, matchedRoot: null, source: 'flag' });
  const candidates = descriptors(os.tmpdir());
  const checks = await Promise.all(candidates.map((candidate) => ping(candidate.port, '/ping')));
  try {
    return (cachedTarget = resolvePort(
      candidates.filter((_, index) => checks[index]),
      { cwd: process.cwd() },
    ));
  } catch (error) {
    if (error instanceof AmbiguousPortError) throw error;
    if (!(error instanceof NoServerError)) throw error;
  }
  try {
    const legacy = Number.parseInt(fs.readFileSync(path.join(os.tmpdir(), 'diff-review-port'), 'utf-8').trim(), 10);
    if (Number.isSafeInteger(legacy) && (await ping(legacy, '/health'))) {
      process.stderr.write(
        '[diff-review] Warning: resolved via the deprecated global port file. ' +
          'If multiple VS Code windows are open, this may be the wrong one. Update the extension to fix this.\n',
      );
      return (cachedTarget = { port: legacy, matchedRoot: null, source: 'sole-live' });
    }
  } catch {
    // The legacy pointer is optional during the migration grace period.
  }
  throw new NoServerError();
}

export async function postToMcpTarget<T = unknown>(endpoint: string, data: object): Promise<T> {
  return postIpcJson<T>(endpoint, await resolveMcpTarget(), data);
}
