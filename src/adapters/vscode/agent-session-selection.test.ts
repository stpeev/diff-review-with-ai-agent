import { expect, test, vi } from 'vitest';
import { selectAgentSession } from './agent-session-selection';

const sessions = [
  {
    agent: 'codex' as const,
    sessionId: 'codex-123456',
    label: 'First',
    cwd: '/workspace',
    registeredAt: '2026-09-13T00:00:00.000Z',
    lastSeenAt: '2026-09-13T00:00:00.000Z',
  },
  {
    agent: 'claude' as const,
    sessionId: 'claude-654321',
    label: 'Second',
    cwd: '/workspace',
    registeredAt: '2026-09-13T00:00:00.000Z',
    lastSeenAt: '2026-09-13T00:01:00.000Z',
  },
];

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    sessions: () => sessions,
    getBoundSessionId: () => undefined,
    setBoundSessionId: vi.fn(async () => undefined),
    pick: vi.fn(async () => undefined),
    log: vi.fn(),
    sessionName: (session: (typeof sessions)[number]) => `${session.agent}:${session.sessionId.slice(-6)}`,
    ...overrides,
  };
}

test('uses and preserves a valid remembered session binding', async () => {
  const deps = dependencies({ getBoundSessionId: () => 'claude-654321' });

  await expect(selectAgentSession(deps)).resolves.toEqual(sessions[1]);

  expect(deps.pick).not.toHaveBeenCalled();
  expect(deps.setBoundSessionId).not.toHaveBeenCalled();
});

test('automatically binds the only available session', async () => {
  const onlySession = [sessions[0]!];
  const deps = dependencies({ sessions: () => onlySession });

  await expect(selectAgentSession(deps)).resolves.toEqual(onlySession[0]);

  expect(deps.setBoundSessionId).toHaveBeenCalledWith('codex-123456');
});

test('uses the picker when multiple sessions have no valid automatic binding', async () => {
  const deps = dependencies({ pick: vi.fn(async () => sessions[1]) });

  await expect(selectAgentSession(deps)).resolves.toEqual(sessions[1]);

  expect(deps.setBoundSessionId).toHaveBeenCalledWith('claude-654321');
});
