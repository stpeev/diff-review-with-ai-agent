import { expect, test, vi } from 'vitest';
import { registerReviewPromptCommands } from './review-prompt-commands';

interface Thread {
  id: number;
  open: boolean;
}

function setup() {
  const callbacks = new Map<string, (...args: any[]) => unknown>();
  const deps = {
    registerCommand: vi.fn((command: string, callback: (...args: any[]) => unknown) => {
      callbacks.set(command, callback);
      return { dispose: vi.fn() };
    }),
    allLiveThreads: vi.fn(() => [
      { id: 1, open: true },
      { id: 2, open: false },
    ]),
    threadsForFile: vi.fn((file: string) => (file === 'a.ts' ? [{ id: 1, open: true }] : undefined)),
    isOpen: (thread: Thread) => thread.open,
    buildPrompt: vi.fn(async (threads: Thread[]) => `prompt:${threads.map((thread) => thread.id).join(',')}`),
    executeCommand: vi.fn(async () => undefined),
    writeClipboard: vi.fn(async () => undefined),
    showInformation: vi.fn(),
  };
  const subscriptions: { dispose(): unknown }[] = [];
  registerReviewPromptCommands(subscriptions, deps);
  return { callbacks, deps, subscriptions };
}

test('registers the prompt-related commands', () => {
  const { callbacks, subscriptions } = setup();

  expect([...callbacks.keys()]).toEqual([
    'diffReview.submitFile',
    'diffReview.copyThread',
    'diffReview.copyAll',
    'diffReview.copyFile',
  ]);
  expect(subscriptions).toHaveLength(4);
});

test('submits a file prompt and copies it when chat cannot open', async () => {
  const { callbacks, deps } = setup();
  deps.executeCommand.mockRejectedValueOnce(new Error('unavailable'));

  await callbacks.get('diffReview.submitFile')?.('a.ts');

  expect(deps.buildPrompt).toHaveBeenCalledWith([{ id: 1, open: true }]);
  expect(deps.writeClipboard).toHaveBeenCalledWith('prompt:1');
  expect(deps.showInformation).toHaveBeenCalledWith('Prompt copied to clipboard.');
});

test('copies all live open threads and reports an empty file', async () => {
  const { callbacks, deps } = setup();

  await callbacks.get('diffReview.copyAll')?.();
  await callbacks.get('diffReview.copyFile')?.('missing.ts');

  expect(deps.writeClipboard).toHaveBeenCalledWith('prompt:1');
  expect(deps.showInformation).toHaveBeenLastCalledWith('No open comments in this file.');
});
