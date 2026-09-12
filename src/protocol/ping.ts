import * as http from 'http';

/** Check that a loopback IPC endpoint answers its health ping within a bounded time. */
export function pingIpcEndpoint(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/ping`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
  });
}
