import * as http from 'http';
import { expect, test } from 'vitest';
import { pingIpcEndpoint } from './ping';

test('accepts only a successful loopback ping response', async () => {
  const server = http.createServer((_request, response) => response.writeHead(200).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
    await expect(pingIpcEndpoint(address.port)).resolves.toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
