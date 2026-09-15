import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { serveAwaitReview } from './review-await';
import { ReviewWaiters } from './review-waiters';
import { startLoopbackHttpServer, type LoopbackHttpServer } from './server';

const servers: LoopbackHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function requestJson(port: number, path: string): { request: http.ClientRequest; response: Promise<unknown> } {
  let resolveResponse!: (value: unknown) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<unknown>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = http.get(`http://127.0.0.1:${port}${path}`, (result) => {
    let body = '';
    result.setEncoding('utf8');
    result.on('data', (chunk) => (body += chunk));
    result.on('end', () => resolveResponse(JSON.parse(body)));
  });
  request.on('error', rejectResponse);
  return { request, response };
}

test('await route releases a waiting request when a new review generation arrives', async () => {
  const waiters = new ReviewWaiters();
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => (handlerStarted = resolve));
  const server = await startLoopbackHttpServer((request, response) => {
    handlerStarted();
    serveAwaitReview(request, response, waiters, 0, { timeoutMs: 100 });
  });
  servers.push(server);

  const pending = requestJson(server.port, '/review/await');
  await started;
  expect(waiters.size).toBe(1);
  waiters.announce();

  await expect(pending.response).resolves.toEqual({ pending: true, generation: 1 });
  expect(waiters.size).toBe(0);
});

test('await route removes a waiter when the caller disconnects', async () => {
  const waiters = new ReviewWaiters();
  const request = new EventEmitter() as unknown as http.IncomingMessage;
  const response = new EventEmitter() as http.ServerResponse;
  response.writeHead = () => response;
  response.end = () => response;

  serveAwaitReview(request, response, waiters, 0, { timeoutMs: 100 });
  expect(waiters.size).toBe(1);
  request.emit('aborted');

  expect(waiters.size).toBe(0);
});
