import { expect, test, vi } from 'vitest';
import {
  autoUpdateInstalledComponents,
  staleCommandFiles,
  type ComponentAutoUpdateDeps,
} from './component-auto-update';
import type { McpConsumerTarget } from '../../mcp-consumers';
import type { CommandFile, SlashCommandTarget } from '../../slash-commands';

function consumer(overrides: Partial<McpConsumerTarget> = {}): McpConsumerTarget {
  return {
    id: 'claude',
    label: 'Claude Code',
    kind: 'claude-json',
    configPath: '/home/u/.claude.json',
    status: 'stale',
    current: 'node /old/extension/out/mcp-server.js',
    writable: true,
    ...overrides,
  };
}

function commandFile(overrides: Partial<CommandFile> = {}): CommandFile {
  return {
    command: 'perform',
    filePath: '/home/u/.claude/commands/perform-diff-review.md',
    invocation: '/perform-diff-review',
    status: 'stale',
    writable: true,
    ...overrides,
  };
}

function commandTarget(overrides: Partial<SlashCommandTarget> = {}): SlashCommandTarget {
  return {
    id: 'claude',
    label: 'Claude Code',
    kind: 'claude-md',
    dirPath: '/home/u/.claude/commands',
    status: 'stale',
    writable: true,
    files: [commandFile()],
    ...overrides,
  };
}

function deps(overrides: Partial<ComponentAutoUpdateDeps> = {}): ComponentAutoUpdateDeps {
  return {
    discoverConsumers: vi.fn(() => []),
    discoverCommands: vi.fn(() => []),
    registerConsumer: vi.fn(() => ({ backup: '/home/u/.claude.json.diff-review-backup' })),
    installCommands: vi.fn(() => ({ written: [], errors: [] })),
    homeShort: (filePath) => filePath.replace('/home/u', '~'),
    log: vi.fn(),
    ...overrides,
  };
}

test('updates a stale consumer and logs the old entry and backup', () => {
  const effects = deps({ discoverConsumers: vi.fn(() => [consumer()]) });
  autoUpdateInstalledComponents(effects);

  expect(effects.registerConsumer).toHaveBeenCalledWith(consumer());
  const lines = vi.mocked(effects.log).mock.calls.map(([line]) => line);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('Claude Code');
  expect(lines[0]).toContain('~/.claude.json');
  expect(lines[0]).toContain('node /old/extension/out/mcp-server.js');
  expect(lines[0]).toContain('~/.claude.json.diff-review-backup');
});

test('never installs: missing, current, and non-writable consumers are left alone', () => {
  const targets = [
    consumer({ id: 'missing', status: 'missing', current: undefined }),
    consumer({ id: 'current', status: 'current', current: undefined }),
    consumer({ id: 'manual', status: 'stale', writable: false, reason: 'the file is not valid JSON' }),
  ];
  const effects = deps({ discoverConsumers: vi.fn(() => targets) });
  autoUpdateInstalledComponents(effects);

  expect(effects.registerConsumer).not.toHaveBeenCalled();
  expect(effects.log).not.toHaveBeenCalled();
});

test('hands installCommands only the stale writable command files', () => {
  const stale = commandFile();
  const current = commandFile({ command: 'address', filePath: '/home/u/x/address-diff-review.md', status: 'current' });
  const missing = commandFile({
    command: 'register',
    filePath: '/home/u/x/register-for-diff-review-send.md',
    status: 'missing',
  });
  const foreign = commandFile({ command: 'unregister', status: 'stale', writable: false, reason: 'not ours' });
  const target = commandTarget({ files: [stale, current, missing, foreign] });
  const effects = deps({
    discoverCommands: vi.fn(() => [target]),
    installCommands: vi.fn(() => ({
      written: [
        { command: 'perform' as const, filePath: stale.filePath, backup: stale.filePath + '.diff-review-backup' },
      ],
      errors: [],
    })),
  });
  autoUpdateInstalledComponents(effects);

  expect(effects.installCommands).toHaveBeenCalledWith({ ...target, files: [stale] });
  const lines = vi.mocked(effects.log).mock.calls.map(([line]) => line);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('~/.claude/commands/perform-diff-review.md');
  expect(lines[0]).toContain('.diff-review-backup');
});

test('a target with no stale writable files is skipped without a write', () => {
  const target = commandTarget({
    status: 'missing',
    files: [
      commandFile({ status: 'current' }),
      commandFile({ command: 'address', status: 'missing' }),
      commandFile({ command: 'register', status: 'stale', writable: false }),
    ],
  });
  const effects = deps({ discoverCommands: vi.fn(() => [target]) });
  autoUpdateInstalledComponents(effects);

  expect(effects.installCommands).not.toHaveBeenCalled();
  expect(effects.log).not.toHaveBeenCalled();
});

test('failures are logged per component and do not stop the others', () => {
  const badConsumer = consumer({ id: 'codex', label: 'Codex CLI', configPath: '/home/u/.codex/config.toml' });
  const goodConsumer = consumer();
  const badCommand = commandTarget({
    id: 'gemini',
    label: 'Gemini CLI',
    files: [commandFile({ filePath: '/home/u/.gemini/commands/perform-diff-review.toml' })],
  });
  const goodCommand = commandTarget();
  const effects = deps({
    discoverConsumers: vi.fn(() => [badConsumer, goodConsumer]),
    discoverCommands: vi.fn(() => [badCommand, goodCommand]),
    registerConsumer: vi.fn((target: McpConsumerTarget) => {
      if (target.id === 'codex') throw new Error('EACCES');
      return {};
    }),
    installCommands: vi.fn((target: SlashCommandTarget) => {
      if (target.id === 'gemini') throw new Error('EACCES');
      return {
        written: [{ command: 'perform' as const, filePath: target.files[0].filePath }],
        errors: [
          {
            command: 'address' as const,
            filePath: '/home/u/.claude/commands/address-diff-review.md',
            message: 'EACCES',
          },
        ],
      };
    }),
  });
  autoUpdateInstalledComponents(effects);

  const lines = vi.mocked(effects.log).mock.calls.map(([line]) => line);
  expect(lines.some((line) => line.includes('Codex CLI') && line.includes('EACCES'))).toBe(true);
  expect(lines.some((line) => line.includes('Claude Code') && line.includes('Auto-updated'))).toBe(true);
  expect(lines.some((line) => line.includes('Gemini CLI') && line.includes('EACCES'))).toBe(true);
  expect(lines.some((line) => line.includes('address-diff-review.md') && line.includes('EACCES'))).toBe(true);
});

test('staleCommandFiles returns undefined when nothing is stale and ours', () => {
  expect(staleCommandFiles(commandTarget({ files: [commandFile({ status: 'current' })] }))).toBeUndefined();
  const narrowed = staleCommandFiles(commandTarget());
  expect(narrowed?.files).toEqual([commandFile()]);
});
