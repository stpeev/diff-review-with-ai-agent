import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackHttpServer {
  port: number;
  close(): Promise<void>;
}

/** Start an HTTP server on an ephemeral localhost-only port. */
export function startLoopbackHttpServer(handler: http.RequestListener): Promise<LoopbackHttpServer> {
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    const rejectStart = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectStart);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to get loopback server address'));
        return;
      }
      resolve({
        port: (address as AddressInfo).port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}
