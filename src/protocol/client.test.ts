import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { getIpcJson, postIpcJson } from './client';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('postIpcJson attaches the resolved workspace root', async () => {
  const port = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.end(Buffer.concat(chunks));
    });
  });

  await expect(
    postIpcJson('/reply', { port, matchedRoot: '/workspace' }, { threadId: 4, text: 'done' }),
  ).resolves.toEqual({ threadId: 4, text: 'done', expectWorkspaceRoot: '/workspace' });
});

test('getIpcJson rejects error responses with the server error', async () => {
  const port = await startServer((_request, response) => {
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'Thread #4 not found.' }));
  });

  await expect(getIpcJson('/comments', { port, matchedRoot: null })).rejects.toThrow('Thread #4 not found.');
});

test('getIpcJson rejects a request that exceeds its timeout', async () => {
  const port = await startServer(() => {
    // Leave the request open until the client timeout destroys it.
  });

  await expect(getIpcJson('/comments', { port, matchedRoot: null }, 10)).rejects.toThrow('IPC request timeout');
});
