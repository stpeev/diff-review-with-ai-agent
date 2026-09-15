import { expect, test, vi } from 'vitest';
import { consumerStatusNote, registerMcpConsumer, type McpConsumerRegistrationDeps } from './mcp-consumer-registration';
import type { McpConsumerTarget } from '../../mcp-consumers';

const target: McpConsumerTarget = {
  id: 'codex',
  label: 'Codex',
  kind: 'codex-toml',
  configPath: '/tmp/config.toml',
  status: 'missing',
  writable: true,
};

function deps(answer: 'Write' | 'Copy' | undefined = 'Write'): McpConsumerRegistrationDeps {
  return {
    launcherFile: '/tmp/launcher.js',
    renderSnippet: () => 'snippet',
    snippetDestination: () => 'clipboard',
    register: vi.fn(() => ({})),
    copy: vi.fn(async () => undefined),
    information: vi.fn(async () => undefined),
    confirm: vi.fn(async () => answer),
    warning: vi.fn(async () => undefined),
    log: vi.fn(),
    homeShort: (file) => file,
    installAgentCommands: vi.fn(),
  };
}

test('consumer status notes expose registration state', () => {
  expect(consumerStatusNote(target)).toBe('not registered');
  expect(consumerStatusNote({ ...target, status: 'current' })).toBe('registered');
  expect(consumerStatusNote({ ...target, writable: false, reason: 'invalid' })).toBe(
    'not registered (manual) — invalid',
  );
});

test('registration writes after confirmation and can install commands', async () => {
  const effects = deps();
  effects.information = vi.fn(async (_message, action) => action);
  await registerMcpConsumer(target, effects);
  expect(effects.register).toHaveBeenCalledWith(target);
  expect(effects.installAgentCommands).toHaveBeenCalledOnce();
});

test('a current registration reports success without prompting or rewriting', async () => {
  const effects = deps();
  await registerMcpConsumer({ ...target, status: 'current' }, effects);
  expect(effects.information).toHaveBeenCalledWith('Diff Review: Codex is already registered against the launcher.');
  expect(effects.confirm).not.toHaveBeenCalled();
  expect(effects.register).not.toHaveBeenCalled();
});

test('manual, copy, and write failures copy a repair snippet', async () => {
  const manual = deps();
  await registerMcpConsumer({ ...target, writable: false, reason: 'invalid' }, manual);
  expect(manual.copy).toHaveBeenCalledWith('snippet');

  const copied = deps('Copy');
  await registerMcpConsumer(target, copied);
  expect(copied.register).not.toHaveBeenCalled();
  expect(copied.copy).toHaveBeenCalledWith('snippet');

  const failed = deps();
  failed.register = vi.fn(() => {
    throw new Error('denied');
  });
  await registerMcpConsumer(target, failed);
  expect(failed.copy).toHaveBeenCalledWith('snippet');
  expect(failed.warning).toHaveBeenCalledOnce();
});
