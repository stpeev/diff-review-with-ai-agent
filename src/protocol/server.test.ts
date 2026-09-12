import * as http from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { startLoopbackHttpServer, type LoopbackHttpServer } from './server';

const servers: LoopbackHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

test('startLoopbackHttpServer serves only through an ephemeral loopback port', async () => {
  const server = await startLoopbackHttpServer((_request, response) => response.end('ok'));
  servers.push(server);

  const response = await new Promise<string>((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${server.port}`, (result) => {
        let body = '';
        result.setEncoding('utf8');
        result.on('data', (chunk) => (body += chunk));
        result.on('end', () => resolve(body));
      })
      .on('error', reject);
  });

  expect(server.port).toBeGreaterThan(0);
  expect(response).toBe('ok');
});

test('close resolves after the loopback listener stops accepting connections', async () => {
  const server = await startLoopbackHttpServer((_request, response) => response.end());
  await server.close();

  await expect(
    new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.port}`, () => resolve()).on('error', () => reject(new Error('closed')));
    }),
  ).rejects.toThrow('closed');
});
