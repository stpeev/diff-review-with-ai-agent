import { expect, test, vi } from 'vitest';
import { AgentRegistry } from '../agent-registry';
import { handleAgentSessionRoute } from './agent-session-routes';

function deps() {
  const sessions = new AgentRegistry();
  return {
    sessions,
    workspaceMatches: vi.fn(() => true),
    cwdInWorkspace: vi.fn(() => true),
    clearBoundSession: vi.fn(async () => undefined),
    verifyClaudeSession: vi.fn(() => true),
    claudePidFromSocketPath: vi.fn(() => 42),
    log: vi.fn(),
  };
}

test('register route validates workspace ownership before mutating the session registry', async () => {
  const effects = deps();
  effects.workspaceMatches.mockReturnValue(false);

  await expect(
    handleAgentSessionRoute(
      '/session/register',
      JSON.stringify({ agent: 'codex', sessionId: 'session-123', cwd: '/other' }),
      effects,
    ),
  ).resolves.toEqual({ status: 409, body: { error: 'workspace mismatch' } });
  expect(effects.sessions.list()).toEqual([]);
});

test('register route rejects an unverified Claude session', async () => {
  const effects = deps();
  effects.verifyClaudeSession.mockReturnValue(false);

  await expect(
    handleAgentSessionRoute(
      '/session/register',
      JSON.stringify({
        agent: 'claude',
        sessionId: 'session-123',
        cwd: '/workspace',
        socketPath: '/tmp/42.sock',
        token: 'token',
      }),
      effects,
    ),
  ).resolves.toEqual({ status: 400, body: { error: 'Claude session identity could not be verified' } });
  expect(effects.sessions.list()).toEqual([]);
});

test('unregister route removes a session and clears its saved binding', async () => {
  const effects = deps();
  effects.sessions.register({ agent: 'codex', sessionId: 'session-123', label: 'Review work', cwd: '/workspace' });

  await expect(
    handleAgentSessionRoute('/session/unregister', JSON.stringify({ sessionId: 'session-123' }), effects),
  ).resolves.toEqual({ status: 200, body: { ok: true, removed: true } });
  expect(effects.clearBoundSession).toHaveBeenCalledWith('session-123');
  expect(effects.sessions.list()).toEqual([]);
});
