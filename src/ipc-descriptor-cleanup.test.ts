import { expect, test, vi } from 'vitest';
import { sweepStaleDescriptors } from './ipc-descriptor-cleanup';

test('removes malformed and unreachable descriptors while retaining live descriptors', async () => {
  const removed: string[] = [];
  const log = vi.fn();
  await sweepStaleDescriptors('/tmp', async (port) => port === 2, log, {
    readDirectory: () => ['stale.json', 'live.json', 'broken.json', 'note.txt'],
    readFile: (file) =>
      file.endsWith('stale.json') ? '{"port":1}' : file.endsWith('live.json') ? '{"port":2}' : 'not json',
    removeFile: (file) => removed.push(file),
  });
  expect(removed).toEqual(['/tmp/diff-review/stale.json', '/tmp/diff-review/broken.json']);
  expect(log).toHaveBeenCalledWith('Swept stale IPC descriptor stale.json');
});
