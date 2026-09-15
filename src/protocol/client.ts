import * as http from 'node:http';

export interface IpcTarget {
  port: number;
  matchedRoot: string | null;
}

export function getIpcJson<T>(endpoint: string, target: IpcTarget, timeoutMs = 5_000): Promise<T> {
  return requestJson<T>(target, endpoint, 'GET', undefined, timeoutMs);
}

export function postIpcJson<T>(endpoint: string, target: IpcTarget, data: object, timeoutMs = 5_000): Promise<T> {
  return requestJson<T>(
    target,
    endpoint,
    'POST',
    JSON.stringify({ ...data, expectWorkspaceRoot: target.matchedRoot ?? undefined }),
    timeoutMs,
  );
}

function requestJson<T>(
  target: IpcTarget,
  endpoint: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: endpoint,
        method,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let result: Record<string, unknown>;
          try {
            result = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch (error) {
            reject(error);
            return;
          }

          if (response.statusCode === 409) {
            reject(
              new Error(
                `This request was routed to a window scoped to [${asStringList(result.have).join(', ') || 'no workspace folder'}], ` +
                  `not the workspace this call expected (${target.matchedRoot}). Another VS Code window may own your comments — ` +
                  'run "Diff Review: Show MCP Server Info" to check.',
              ),
            );
          } else if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(typeof result.error === 'string' ? result.error : `HTTP ${response.statusCode}`));
          } else {
            resolve(result as T);
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error('IPC request timeout'));
    });
    if (body) request.write(body);
    request.end();
  });
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
