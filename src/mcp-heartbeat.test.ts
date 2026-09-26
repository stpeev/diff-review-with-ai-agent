import { expect, test, vi } from 'vitest';
import type { ResolveResult } from './ipc-discovery';
import { createTargetHeartbeat } from './mcp-heartbeat';

const cwdTarget: ResolveResult = { port: 1, matchedRoot: '/repo', source: 'cwd-match' };

function heartbeat(options: { saved?: ResolveResult; held?: boolean } = {}) {
  const resolver = {
    saved: vi.fn(() => ('saved' in options ? options.saved : cwdTarget)),
    isHeld: vi.fn(() => options.held ?? false),
    rescan: vi.fn().mockResolvedValue(undefined),
  };
  const probe = vi.fn().mockResolvedValue(['/repo']);
  const log = vi.fn();
  return { resolver, probe, log, beat: createTargetHeartbeat({ resolver, probe, log }) };
}

test('a healthy ping does nothing and logs nothing', async () => {
  const { beat, resolver, log } = heartbeat();
  await beat.tick();
  expect(resolver.rescan).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test('a failed ping re-scans and logs the loss once', async () => {
  const { beat, resolver, probe, log } = heartbeat();
  probe.mockResolvedValue(undefined);
  await beat.tick();
  await beat.tick();
  expect(resolver.rescan).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledTimes(1);
});

test('a window that lacks the saved root counts as dead', async () => {
  const { beat, resolver, probe } = heartbeat();
  probe.mockResolvedValue(['/other']);
  await beat.tick();
  expect(resolver.rescan).toHaveBeenCalledOnce();
});

test('a held resolver re-scans without pinging', async () => {
  const { beat, resolver, probe } = heartbeat({ held: true });
  await beat.tick();
  expect(probe).not.toHaveBeenCalled();
  expect(resolver.rescan).toHaveBeenCalledOnce();
});

test('a recovered window logs the loss again next time', async () => {
  const { beat, probe, resolver, log } = heartbeat();
  probe.mockResolvedValueOnce(undefined);
  resolver.rescan.mockResolvedValueOnce({ ...cwdTarget, port: 2 });
  await beat.tick();
  probe.mockResolvedValueOnce(undefined);
  await beat.tick();
  expect(log).toHaveBeenCalledTimes(2);
});

test('does nothing before a target is saved or with a fixed port', async () => {
  const none = heartbeat({ saved: undefined });
  await none.beat.tick();
  const flag = heartbeat({ saved: { port: 9, matchedRoot: null, source: 'flag' } });
  await flag.beat.tick();
  expect(none.probe).not.toHaveBeenCalled();
  expect(flag.probe).not.toHaveBeenCalled();
});

test('skips a tick while the previous one is still running', async () => {
  const { beat, probe } = heartbeat();
  let finish: (roots: string[]) => void = () => {};
  probe.mockImplementation(() => new Promise<string[]>((resolve) => (finish = resolve)));

  const first = beat.tick();
  await beat.tick();
  expect(probe).toHaveBeenCalledOnce();
  finish(['/repo']);
  await first;
});

test('logs and survives an unexpected failure', async () => {
  const { beat, resolver, log } = heartbeat({ held: true });
  resolver.rescan.mockRejectedValue(new Error('boom'));
  await beat.tick();
  expect(log).toHaveBeenCalledWith('Heartbeat failed: boom');
});
