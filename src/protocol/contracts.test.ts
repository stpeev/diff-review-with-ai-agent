import { expect, test } from 'vitest';
import {
  createRequestSchema,
  IpcValidationError,
  parseIpcRequest,
  replyRequestSchema,
  sessionRegisterRequestSchema,
  sessionUnregisterRequestSchema,
  threadMutationRequestSchema,
} from './contracts';

test('parseIpcRequest validates review mutation input before use', () => {
  expect(parseIpcRequest('{"threadId":4,"text":"done"}', replyRequestSchema)).toEqual({ threadId: 4, text: 'done' });
  expect(() => parseIpcRequest('{"threadId":"4","text":"done"}', replyRequestSchema)).toThrow(IpcValidationError);
  expect(() => parseIpcRequest('{bad json', replyRequestSchema)).toThrow('Request body must be valid JSON.');
});

test('session contracts reject malformed registration and removal requests', () => {
  expect(parseIpcRequest('{"sessionId":"codex-1"}', sessionUnregisterRequestSchema)).toEqual({ sessionId: 'codex-1' });
  expect(() => parseIpcRequest('{"sessionId":""}', sessionUnregisterRequestSchema)).toThrow(IpcValidationError);
  expect(
    parseIpcRequest(
      '{"agent":"claude","sessionId":"claude-1","cwd":"/workspace","socketPath":"/tmp/claude-5.sock","pid":5}',
      sessionRegisterRequestSchema,
    ),
  ).toMatchObject({ agent: 'claude', sessionId: 'claude-1', pid: 5 });
  expect(() =>
    parseIpcRequest('{"agent":"other","sessionId":"x","cwd":"/workspace"}', sessionRegisterRequestSchema),
  ).toThrow(IpcValidationError);
  expect(() =>
    parseIpcRequest('{"agent":"codex","sessionId":"x","cwd":"/workspace","pid":0}', sessionRegisterRequestSchema),
  ).toThrow(IpcValidationError);
});

test('review contracts preserve only valid locations and thread handles', () => {
  expect(parseIpcRequest('{"path":"src/a.ts","line":1,"text":"Review this"}', createRequestSchema)).toMatchObject({
    path: 'src/a.ts',
    line: 1,
  });
  expect(() => parseIpcRequest('{"path":"src/a.ts","line":0,"text":"Review this"}', createRequestSchema)).toThrow(
    IpcValidationError,
  );
  expect(() =>
    parseIpcRequest('{"path":"src/a.ts","line":4,"endLine":3,"text":"Review this"}', createRequestSchema),
  ).toThrow('endLine must not be before line.');
  expect(() => parseIpcRequest('{"threadId":0}', threadMutationRequestSchema)).toThrow(IpcValidationError);
});
