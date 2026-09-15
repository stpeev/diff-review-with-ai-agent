import { expect, test, vi } from 'vitest';
import { installAgentSlashCommands, type SlashCommandInstallationDeps } from './slash-command-installation';
import type { SlashCommandTarget } from '../../slash-commands';

const target: SlashCommandTarget = {
  id: 'codex',
  label: 'Codex',
  kind: 'codex-md',
  dirPath: '/tmp',
  status: 'missing',
  writable: true,
  files: [
    {
      command: 'perform',
      filePath: '/tmp/perform.md',
      invocation: '/perform-diff-review',
      status: 'missing',
      writable: true,
    },
  ],
};
function deps(answer: 'Write' | 'Copy' | undefined = 'Write'): SlashCommandInstallationDeps {
  return {
    install: vi.fn(() => ({ written: [], errors: [] })),
    copyCommands: vi.fn(async () => undefined),
    copyCommand: vi.fn(async () => undefined),
    confirm: vi.fn(async () => answer),
    information: vi.fn(async () => undefined),
    warning: vi.fn(async () => undefined),
    log: vi.fn(),
    homeShort: (value) => value,
  };
}
test('current and copy-only targets are never written', async () => {
  const current = deps();
  await installAgentSlashCommands({ ...target, status: 'current' }, current);
  expect(current.install).not.toHaveBeenCalled();
  const manual = deps();
  await installAgentSlashCommands({ ...target, writable: false }, manual);
  expect(manual.copyCommands).toHaveBeenCalledWith({ ...target, writable: false });
});
test('writes after confirmation and copies failed files', async () => {
  const effects = deps();
  effects.install = vi.fn(() => ({
    written: [{ filePath: '/tmp/perform.md' }],
    errors: [{ filePath: '/tmp/address.md', message: 'denied', command: 'address' as const }],
  }));
  await installAgentSlashCommands(target, effects);
  expect(effects.install).toHaveBeenCalledWith(target);
  expect(effects.copyCommand).toHaveBeenCalledWith(target, 'address');
  expect(effects.warning).toHaveBeenCalledOnce();
});
