import { expect, test } from 'vitest';
import { slashCommandRowIcon, slashCommandRowLabel } from './slash-command-presentation';
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
test('renders missing, current, stale, partial, and manual command-target states', () => {
  expect([slashCommandRowIcon(target), slashCommandRowLabel(target)]).toEqual(['$(circle-outline)', 'not installed']);
  expect(
    slashCommandRowLabel({ ...target, status: 'current', files: [{ ...target.files[0], status: 'current' }] }),
  ).toBe('installed');
  expect(slashCommandRowLabel({ ...target, files: [{ ...target.files[0], status: 'stale' }] })).toBe(
    'installed — older version',
  );
  expect(
    slashCommandRowLabel({
      ...target,
      files: [
        { ...target.files[0], status: 'current' },
        { ...target.files[0], command: 'address', status: 'missing' },
      ],
    }),
  ).toBe('1 of 2 installed');
  expect(slashCommandRowLabel({ ...target, writable: false })).toBe('not installed (manual)');
});
