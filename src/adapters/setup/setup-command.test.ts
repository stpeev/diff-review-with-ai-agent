import { expect, test, vi } from 'vitest';
import type { McpConsumerTarget } from '../../mcp-consumers';
import type { CommandFile, CommandId, InstallOutcome, SlashCommandTarget } from '../../slash-commands';
import { INVOCATION } from '../../slash-commands';
import {
  applySetup,
  consumerStatusNote,
  setupRowDescription,
  setupRowDetail,
  setupRowIcon,
  setupRows,
  type SetupDeps,
} from './setup-command';

const COMMANDS: CommandId[] = ['perform', 'address', 'register', 'unregister'];

function commandFile(command: CommandId, overrides: Partial<CommandFile> = {}): CommandFile {
  return {
    command,
    filePath: `/home/u/.claude/commands/${command}.md`,
    invocation: INVOCATION[command],
    status: 'missing',
    writable: true,
    ...overrides,
  };
}

function claudeConsumer(overrides: Partial<McpConsumerTarget> = {}): McpConsumerTarget {
  return {
    id: 'claude',
    label: 'Claude Code',
    kind: 'claude-json',
    configPath: '/home/u/.claude.json',
    status: 'missing',
    writable: true,
    ...overrides,
  };
}

function claudeCommands(overrides: Partial<SlashCommandTarget> = {}): SlashCommandTarget {
  return {
    id: 'claude',
    label: 'Claude Code',
    kind: 'claude-md',
    dirPath: '/home/u/.claude/commands',
    files: COMMANDS.map((command) => commandFile(command)),
    status: 'missing',
    writable: true,
    ...overrides,
  };
}

function deps() {
  return {
    registerConsumer: vi.fn((_target: McpConsumerTarget) => ({}) as { backup?: string }),
    installCommands: vi.fn((_target: SlashCommandTarget): InstallOutcome => ({ written: [], errors: [] })),
    renderSnippet: vi.fn((target: McpConsumerTarget) => `snippet:${target.id}`),
    renderClipboard: vi.fn((target: SlashCommandTarget, command: CommandId) => `clipboard:${target.id}:${command}`),
    copy: vi.fn(async (_text: string) => undefined),
    information: vi.fn(async (_message: string) => undefined),
    warning: vi.fn(async (_message: string) => undefined),
    log: vi.fn(),
    homeShort: (filePath: string) => filePath.replace('/home/u', '~'),
  } satisfies SetupDeps;
}

test('setup rows merge both halves of the same place and keep single-half places', () => {
  const rows = setupRows(
    [claudeConsumer(), { ...claudeConsumer(), id: 'cursor', label: 'Cursor' }],
    [claudeCommands(), { ...claudeCommands(), id: 'gemini', label: 'Gemini CLI' }],
  );

  expect(rows.map((row) => row.id)).toEqual(['claude', 'cursor', 'gemini']);
  expect(rows[0].consumer?.configPath).toBe('/home/u/.claude.json');
  expect(rows[0].commands?.dirPath).toBe('/home/u/.claude/commands');
  expect(rows[1].consumer?.label).toBe('Cursor');
  expect(rows[1].commands).toBeUndefined();
  expect(rows[2].commands?.label).toBe('Gemini CLI');
  expect(rows[2].consumer).toBeUndefined();
});

test('row presentation summarizes both halves', () => {
  const [fresh] = setupRows([claudeConsumer()], [claudeCommands()]);
  expect(setupRowIcon(fresh)).toBe('$(circle-outline)');
  expect(setupRowDescription(fresh)).toBe('MCP: not registered · commands: not installed');
  expect(setupRowDetail(fresh, (filePath) => filePath.replace('/home/u', '~'))).toBe(
    '~/.claude.json\n~/.claude/commands',
  );

  const [done] = setupRows(
    [claudeConsumer({ status: 'current' })],
    [
      claudeCommands({
        status: 'current',
        files: COMMANDS.map((command) => commandFile(command, { status: 'current' })),
      }),
    ],
  );
  expect(setupRowIcon(done)).toBe('$(check)');
  expect(setupRowDescription(done)).toBe('MCP: registered · commands: installed');

  const [stale] = setupRows(
    [claudeConsumer()],
    [claudeCommands({ status: 'stale', files: COMMANDS.map((command) => commandFile(command, { status: 'stale' })) })],
  );
  expect(setupRowIcon(stale)).toBe('$(warning)');
});

test('consumer status notes expose registration state', () => {
  expect(consumerStatusNote(claudeConsumer())).toBe('not registered');
  expect(consumerStatusNote(claudeConsumer({ status: 'current' }))).toBe('registered');
  expect(consumerStatusNote(claudeConsumer({ status: 'stale', current: 'node old.js' }))).toBe(
    'registered — runs node old.js',
  );
  expect(consumerStatusNote(claudeConsumer({ writable: false, reason: 'invalid' }))).toBe(
    'not registered (manual) — invalid',
  );
});

test('applySetup writes both halves of the picked rows and leaves the rest alone', async () => {
  const effects = deps();
  effects.registerConsumer = vi.fn(() => ({ backup: '/home/u/.claude.json.bak' }));
  effects.installCommands = vi.fn(
    (): InstallOutcome => ({
      written: [{ command: 'perform', filePath: '/home/u/.claude/commands/perform.md' }],
      errors: [],
    }),
  );
  const rows = setupRows(
    [claudeConsumer(), { ...claudeConsumer(), id: 'codex', label: 'Codex CLI' }],
    [claudeCommands()],
  );

  await applySetup([rows[0]], effects);

  expect(effects.registerConsumer).toHaveBeenCalledExactlyOnceWith(rows[0].consumer);
  expect(effects.installCommands).toHaveBeenCalledExactlyOnceWith(rows[0].commands);
  const messages = effects.information.mock.calls.map(([message]) => message).join(' ');
  expect(messages).toContain('wrote 2 files');
  expect(messages).toContain('~/.claude.json');
  expect(messages).toContain('Previous versions saved to ~/.claude.json.bak');
  expect(effects.log).toHaveBeenCalledTimes(2);
  expect(effects.copy).not.toHaveBeenCalled();
  expect(effects.warning).not.toHaveBeenCalled();
});

test('an all-current selection reports nothing to do', async () => {
  const effects = deps();
  const rows = setupRows(
    [claudeConsumer({ status: 'current' })],
    [
      claudeCommands({
        status: 'current',
        files: COMMANDS.map((command) => commandFile(command, { status: 'current' })),
      }),
    ],
  );

  await applySetup(rows, effects);

  expect(effects.registerConsumer).not.toHaveBeenCalled();
  expect(effects.installCommands).not.toHaveBeenCalled();
  expect(effects.information).toHaveBeenCalledWith('Diff Review: Claude Code already set up — nothing to do.');
  expect(effects.copy).not.toHaveBeenCalled();
  expect(effects.warning).not.toHaveBeenCalled();
});

test('non-writable parts end on the clipboard instead of being written', async () => {
  const effects = deps();
  const rows = setupRows(
    [claudeConsumer({ writable: false, reason: 'unrecognised config layout' })],
    [
      claudeCommands({
        writable: false,
        files: [commandFile('perform', { writable: false, reason: 'file not written by Diff Review' })],
      }),
    ],
  );

  await applySetup(rows, effects);

  expect(effects.registerConsumer).not.toHaveBeenCalled();
  expect(effects.installCommands).not.toHaveBeenCalled();
  expect(effects.copy).toHaveBeenCalledWith('snippet:claude\n\nclipboard:claude:perform');
  expect(effects.information).toHaveBeenCalledWith(
    'Diff Review: copied 2 items that setup could not write — paste them where they belong.',
  );
});

test('a failed registration falls back to the clipboard and warns', async () => {
  const effects = deps();
  effects.registerConsumer = vi.fn(() => {
    throw new Error('denied');
  });

  await applySetup(setupRows([claudeConsumer()], []), effects);

  expect(effects.copy).toHaveBeenCalledWith('snippet:claude');
  expect(effects.warning).toHaveBeenCalledWith('Diff Review: could not write ~/.claude.json — denied.');
  expect(effects.log).toHaveBeenCalled();
});

test('per-file install failures are copied and reported', async () => {
  const effects = deps();
  effects.installCommands = vi.fn(
    (): InstallOutcome => ({
      written: [{ command: 'perform', filePath: '/home/u/.claude/commands/perform.md' }],
      errors: [{ command: 'address', filePath: '/home/u/.claude/commands/address.md', message: 'denied' }],
    }),
  );

  await applySetup(setupRows([], [claudeCommands()]), effects);

  expect(effects.copy).toHaveBeenCalledWith('clipboard:claude:address');
  expect(effects.warning).toHaveBeenCalledWith('Diff Review: could not write ~/.claude/commands/address.md — denied.');
  const messages = effects.information.mock.calls.map(([message]) => message).join(' ');
  expect(messages).toContain('wrote 1 file');
});

test('a thrown install copies every pending command', async () => {
  const effects = deps();
  effects.installCommands = vi.fn(() => {
    throw new Error('boom');
  });

  await applySetup(setupRows([], [claudeCommands()]), effects);

  expect(effects.copy).toHaveBeenCalledWith(COMMANDS.map((command) => `clipboard:claude:${command}`).join('\n\n'));
  expect(effects.warning).toHaveBeenCalledWith('Diff Review: could not write ~/.claude/commands — boom.');
});
