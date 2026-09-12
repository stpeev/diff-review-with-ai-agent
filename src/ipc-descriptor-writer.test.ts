import { expect, test, vi } from 'vitest';
import { writeIpcDescriptor } from './ipc-descriptor-writer';

test('replaces the prior descriptor and writes both current and legacy discovery records', () => {
  const writes = new Map<string, string>();
  const removeFile = vi.fn();
  const log = vi.fn();
  const file = writeIpcDescriptor(
    { tmpDir: '/tmp', workspaceRoots: ['/workspace'], port: 4567, processId: 99, previousPath: '/tmp/old.json' },
    log,
    {
      mkdir: vi.fn(),
      writeFile: (name, body) => writes.set(name, body),
      removeFile,
      now: () => '2026-09-14T00:00:00.000Z',
    },
  );
  expect(removeFile).toHaveBeenCalledWith('/tmp/old.json');
  expect(JSON.parse(writes.get(file)!)).toMatchObject({ port: 4567, workspaceRoots: ['/workspace'], pid: 99 });
  expect(writes.get('/tmp/diff-review-port')).toBe('4567');
});
