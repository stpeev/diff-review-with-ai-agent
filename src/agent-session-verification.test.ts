import { expect, test } from 'vitest';
import { verifyClaudeSessionIdentity } from './agent-session-verification';

const deps = {
  pidFromSocketPath: () => 42,
  processExists: () => true,
  socketOwnerUid: () => 501,
  currentUid: () => 501,
};

test('verifyClaudeSessionIdentity accepts a live socket owned by the current user', () => {
  expect(verifyClaudeSessionIdentity({ pid: 42, socketPath: '/tmp/claude-42.sock', token: 'token' }, deps)).toEqual({
    ok: true,
    pid: 42,
  });
});

test('verifyClaudeSessionIdentity rejects missing credentials and mismatched process identity', () => {
  expect(verifyClaudeSessionIdentity({ pid: 42, socketPath: '/tmp/claude-42.sock' }, deps)).toEqual({ ok: false });
  expect(verifyClaudeSessionIdentity({ pid: 41, socketPath: '/tmp/claude-42.sock', token: 'token' }, deps)).toEqual({
    ok: false,
  });
  expect(
    verifyClaudeSessionIdentity(
      { pid: 42, socketPath: '/tmp/claude-42.sock', token: 'token' },
      { ...deps, socketOwnerUid: () => 502 },
    ),
  ).toEqual({ ok: false });
});

test('verifyClaudeSessionIdentity rejects missing processes and inspection failures', () => {
  expect(
    verifyClaudeSessionIdentity(
      { pid: 42, socketPath: '/tmp/claude-42.sock', token: 'token' },
      { ...deps, processExists: () => false },
    ),
  ).toEqual({ ok: false });
  expect(
    verifyClaudeSessionIdentity(
      { pid: 42, socketPath: '/tmp/claude-42.sock', token: 'token' },
      {
        ...deps,
        processExists: () => {
          throw new Error('denied');
        },
      },
    ),
  ).toEqual({ ok: false });
});
