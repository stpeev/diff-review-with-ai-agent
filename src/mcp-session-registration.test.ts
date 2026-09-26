import { expect, test, vi } from 'vitest';
import { createMcpSessionRegistrar, type McpSessionRegistrationDependencies } from './mcp-session-registration';

function dependencies(overrides: Partial<McpSessionRegistrationDependencies> = {}): McpSessionRegistrationDependencies {
  return {
    post: vi.fn().mockResolvedValue({}),
    log: vi.fn(),
    environment: {},
    cwd: () => '/workspace',
    claudePidFromSocketPath: vi.fn(),
    claudeSessionLabel: vi.fn(),
    codexSessionLabel: vi.fn(),
    ...overrides,
  };
}

test('deduplicates unnamed Codex registration requests', async () => {
  let completePost: (() => void) | undefined;
  const post = vi.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        completePost = resolve;
      }),
  );
  const registrar = createMcpSessionRegistrar(dependencies({ post }));

  const first = registrar.registerCodexSession('thread-123456');
  const second = registrar.registerCodexSession('thread-123456');
  expect(first).toBe(second);
  expect(post).toHaveBeenCalledOnce();
  completePost?.();
  await expect(first).resolves.toEqual({ ok: true, label: 'Codex 123456' });
});

test('allows a failed Codex registration to retry', async () => {
  const post = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  const registrar = createMcpSessionRegistrar(dependencies({ post }));

  await expect(registrar.registerCodexSession('thread-123456')).resolves.toEqual({ ok: false, error: 'offline' });
  await expect(registrar.registerCodexSession('thread-123456')).resolves.toEqual({ ok: true, label: 'Codex 123456' });
  expect(post).toHaveBeenCalledTimes(2);
});

test('registers Claude with its messaging context and project directory', async () => {
  const post = vi.fn().mockResolvedValue({});
  const registrar = createMcpSessionRegistrar(
    dependencies({
      post,
      environment: {
        CLAUDE_CODE_MESSAGING_SOCKET: '/private/tmp/cc-socks/321.sock',
        CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
        CLAUDE_PROJECT_DIR: '/project',
      },
      claudePidFromSocketPath: vi.fn().mockReturnValue(321),
      claudeSessionLabel: vi.fn().mockReturnValue('Claude topic'),
    }),
  );

  await expect(registrar.registerClaudeSession('session-123456')).resolves.toEqual({ ok: true, label: 'Claude topic' });
  expect(post).toHaveBeenCalledWith('/session/register', {
    agent: 'claude',
    sessionId: 'session-123456',
    cwd: '/project',
    label: 'Claude topic',
    socketPath: '/private/tmp/cc-socks/321.sock',
    token: 'secret',
    pid: 321,
  });
});

test('force sends a new registration instead of reusing the stored one', async () => {
  const post = vi.fn().mockResolvedValue({});
  const registrar = createMcpSessionRegistrar(dependencies({ post }));

  await registrar.registerCodexSession('thread-123456');
  await registrar.registerCodexSession('thread-123456', undefined, { force: true });

  expect(post).toHaveBeenCalledTimes(2);
});

test('replayAll re-sends the stored payload of every successful registration', async () => {
  const post = vi.fn().mockResolvedValue({});
  const registrar = createMcpSessionRegistrar(
    dependencies({ post, environment: { CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_PID: '321' } }),
  );
  await registrar.registerCodexSession('thread-123456');
  await registrar.registerClaudeSession('claude-abcdef');
  post.mockClear();

  await expect(registrar.replayAll()).resolves.toEqual([
    { ok: true, label: 'Codex 123456' },
    { ok: true, label: 'Claude abcdef' },
  ]);

  expect(post).toHaveBeenCalledWith('/session/register', {
    agent: 'codex',
    sessionId: 'thread-123456',
    cwd: '/workspace',
    label: 'Codex 123456',
  });
  expect(post).toHaveBeenCalledWith(
    '/session/register',
    expect.objectContaining({ agent: 'claude', sessionId: 'claude-abcdef', token: 'secret', pid: 321 }),
  );
});

test('a failed replay stays saved for the next target change', async () => {
  const post = vi.fn().mockResolvedValue({});
  const registrar = createMcpSessionRegistrar(dependencies({ post }));
  await registrar.registerCodexSession('thread-123456');

  post.mockRejectedValueOnce(new Error('offline'));
  await expect(registrar.replayAll()).resolves.toEqual([{ ok: false, error: 'offline', label: 'Codex 123456' }]);
  await expect(registrar.replayAll()).resolves.toEqual([{ ok: true, label: 'Codex 123456' }]);
});

test('clear removes a session from the replay set', async () => {
  const post = vi.fn().mockResolvedValue({});
  const registrar = createMcpSessionRegistrar(dependencies({ post }));
  await registrar.registerCodexSession('thread-123456');

  registrar.clear('thread-123456');

  await expect(registrar.replayAll()).resolves.toEqual([]);
});
