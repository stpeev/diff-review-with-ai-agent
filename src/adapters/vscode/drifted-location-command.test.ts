import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { registerDriftedLocationCommand } from './drifted-location-command';

interface FakeThread {
  uri: { path: string };
}

test('opens drift correction actions only for a known drifted thread', () => {
  let handler: ((thread: FakeThread & vscode.CommentThread) => void) | undefined;
  const showActions = vi.fn();
  registerDriftedLocationCommand([], {
    registerCommand: (_command, registered) => {
      handler = registered as (thread: FakeThread & vscode.CommentThread) => void;
      return { dispose: () => undefined } as never;
    },
    publicId: () => 42,
    isDrifted: () => true,
    showActions,
  });

  handler!({ uri: { path: 'src/example.ts' } } as FakeThread & vscode.CommentThread);

  expect(showActions).toHaveBeenCalledWith(42);
});

test('ignores missing or non-drifted comment views', () => {
  const handlers: Array<(thread: FakeThread & vscode.CommentThread) => void> = [];
  const showActions = vi.fn();
  registerDriftedLocationCommand([], {
    registerCommand: (_command, handler) => {
      handlers.push(handler as (thread: FakeThread & vscode.CommentThread) => void);
      return { dispose: () => undefined } as never;
    },
    publicId: () => undefined,
    isDrifted: () => true,
    showActions,
  });
  handlers[0]!({ uri: { path: 'src/example.ts' } } as FakeThread & vscode.CommentThread);

  expect(showActions).not.toHaveBeenCalled();
});
