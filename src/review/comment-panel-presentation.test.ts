import { describe, expect, test } from 'vitest';
import { anchoredLocation, driftedLocation } from './model';
import { commentPanelItems, type CommentPanelThread } from './comment-panel-presentation';

function thread(overrides: Partial<CommentPanelThread> = {}): CommentPanelThread {
  return {
    id: 1,
    file: 'src/example.ts',
    startLine: 4,
    status: 'open',
    location: anchoredLocation(4, 4),
    comments: [{ body: 'First comment', role: 'user' }],
    ...overrides,
  };
}

describe('commentPanelItems', () => {
  test('groups live threads by file and sorts their rows by location', () => {
    const items = commentPanelItems([
      thread({
        id: 2,
        startLine: 9,
        comments: [
          { body: 'Later', role: 'agent' },
          { body: 'Reply', role: 'user' },
        ],
      }),
      thread({ id: 1, startLine: 2, status: 'resolved' }),
    ]);

    expect(items.find((item) => item.label.startsWith('📁'))).toMatchObject({
      label: '📁 src/example.ts  (1 open, 1 resolved)',
    });
    expect(items.filter((item) => item.action === 'commentAction').map((item) => item.label)).toEqual([
      '    ✅ L3: First comment',
      '    💬 L10: Later',
    ]);
    expect(items.find((item) => item.threadId === 2)?.description).toBe('🤖👤  1 reply');
  });

  test('filters rows by file or comment while retaining global actions', () => {
    const items = commentPanelItems(
      [thread(), thread({ id: 2, file: 'src/other.ts', comments: [{ body: 'Needle' }] })],
      'needle',
    );

    expect(items.filter((item) => item.action === 'submitAll')).toHaveLength(1);
    expect(items.filter((item) => item.action === 'commentAction').map((item) => item.threadId)).toEqual([2]);
    expect(items.some((item) => item.label.includes('src/example.ts'))).toBe(false);
  });

  test('keeps drifted threads out of live file rows and offers grouped reattachment', () => {
    const items = commentPanelItems([
      thread({ id: 3, location: driftedLocation(12), comments: [{ body: 'Lost one' }] }),
      thread({ id: 4, location: driftedLocation(14), comments: [{ body: 'Lost two' }] }),
    ]);

    expect(items.some((item) => item.action === 'commentAction')).toBe(false);
    expect(items.find((item) => item.action === 'reattachAllInFile')).toMatchObject({ fileKey: 'src/example.ts' });
    expect(items.filter((item) => item.action === 'driftedAction').map((item) => item.label)).toEqual([
      '    🧩 (was L13): Lost one',
      '    🧩 (was L15): Lost two',
    ]);
  });
});
