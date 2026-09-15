import { describe, expect, test } from 'vitest';
import { commentActionMenu, driftedActionMenu } from './comment-action-presentation';

describe('commentActionMenu', () => {
  test('renders line navigation and resolution state', () => {
    const menu = commentActionMenu({ file: 'src/a.ts', line: 12, preview: 'Check this', resolved: false });

    expect(menu.title).toBe('💬 L12: Check this');
    expect(menu.items[0]).toMatchObject({ description: 'src/a.ts:12', action: 'goto' });
    expect(menu.items.find((item) => item.action === 'resolve')?.label).toContain('Resolve');
  });

  test('offers reopening for resolved threads', () => {
    const menu = commentActionMenu({ file: 'src/a.ts', line: 12, preview: 'Check this', resolved: true });

    expect(menu.title).toContain('✅');
    expect(menu.items.find((item) => item.action === 'unresolve')?.label).toContain('Reopen');
  });
});

describe('driftedActionMenu', () => {
  test('does not offer reattachment when the file is missing', () => {
    const menu = driftedActionMenu({
      file: 'gone.ts',
      preview: 'Lost',
      lastKnownLine: 8,
      fileExists: false,
      resolved: false,
    });

    expect(menu.items.map((item) => item.action)).toEqual(['showContext', 'fileNote', 'toggleResolve', 'delete']);
    expect(menu.items[0].description).toBe('gone.ts (was L9)');
  });

  test('offers line recovery for an existing file', () => {
    const menu = driftedActionMenu({
      file: 'src/a.ts',
      preview: 'Lost',
      lastKnownLine: 8,
      fileExists: true,
      resolved: true,
    });

    expect(menu.items.map((item) => item.action)).toContain('reattach');
    expect(menu.items.map((item) => item.action)).toContain('searchAgain');
    expect(menu.items.find((item) => item.action === 'toggleResolve')?.label).toContain('Reopen');
  });
});
