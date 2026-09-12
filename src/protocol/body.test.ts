import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { readRequestBody, RequestBodyTooLargeError } from './body';

test('readRequestBody collects a bounded request', async () => {
  const stream = new PassThrough();
  const body = readRequestBody(stream, 20);
  stream.end('{"ok":true}');

  await expect(body).resolves.toBe('{"ok":true}');
});

test('readRequestBody rejects and destroys an oversized request', async () => {
  const stream = new PassThrough();
  const body = readRequestBody(stream, 4);
  stream.end('12345');

  await expect(body).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  expect(stream.destroyed).toBe(true);
});
