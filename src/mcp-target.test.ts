import { describe, expect, test, vi } from 'vitest';
import type { Descriptor } from './ipc-discovery';
import { AmbiguousPortError, NoServerError } from './ipc-discovery';
import { IpcHttpError } from './protocol/client';
import {
  createMcpTargetClient,
  createTargetResolver,
  type TargetResolverDependencies,
  WaitingForWindowError,
} from './mcp-target';

function descriptor(port: number, ...workspaceRoots: string[]): Descriptor {
  return { port, workspaceRoots, pid: port, startedAt: '2026-01-01T00:00:00Z' };
}

/** A fake machine: `windows` are the descriptor files, `alive` the ports that answer. */
function machine(overrides: Partial<TargetResolverDependencies> = {}) {
  const state = { windows: [] as Descriptor[], alive: new Set<number>(), legacy: undefined as number | undefined };
  const dependencies: TargetResolverDependencies = {
    listDescriptors: () => state.windows,
    ping: async (port) => state.alive.has(port),
    readLegacyPort: () => state.legacy,
    portFlag: undefined,
    cwd: '/repo/app',
    log: vi.fn(),
    ...overrides,
  };
  const open = (window: Descriptor) => {
    state.windows = [...state.windows.filter((w) => w.port !== window.port), window];
    state.alive.add(window.port);
  };
  const close = (port: number) => {
    state.windows = state.windows.filter((w) => w.port !== port);
    state.alive.delete(port);
  };
  return { state, dependencies, open, close, resolver: createTargetResolver(dependencies) };
}

describe('first connection', () => {
  test('uses the flag without discovery', async () => {
    const { resolver } = machine({ portFlag: 999 });
    await expect(resolver.current()).resolves.toEqual({ port: 999, matchedRoot: null, source: 'flag' });
  });

  test('picks the window whose root contains the cwd', async () => {
    const { resolver, open } = machine();
    open(descriptor(1, '/repo'));
    open(descriptor(2, '/other'));
    await expect(resolver.current()).resolves.toEqual({ port: 1, matchedRoot: '/repo', source: 'cwd-match' });
  });

  test('falls back to the only live window', async () => {
    const { resolver, open } = machine();
    open(descriptor(2, '/other'));
    await expect(resolver.current()).resolves.toMatchObject({ port: 2, source: 'sole-live' });
  });

  test('reports ambiguity and absence', async () => {
    const { resolver, open } = machine();
    await expect(resolver.current()).rejects.toBeInstanceOf(NoServerError);
    open(descriptor(2, '/a'));
    open(descriptor(3, '/b'));
    await expect(resolver.current()).rejects.toBeInstanceOf(AmbiguousPortError);
  });

  test('falls back to a live legacy port file with a warning', async () => {
    const { resolver, state, dependencies } = machine();
    state.legacy = 7;
    state.alive.add(7);
    await expect(resolver.current()).resolves.toEqual({ port: 7, matchedRoot: null, source: 'sole-live' });
    expect(dependencies.log).toHaveBeenCalledWith(expect.stringContaining('deprecated global port file'));
  });

  test('saves the target instead of discovering again', async () => {
    const { resolver, open, close } = machine();
    open(descriptor(1, '/repo'));
    await resolver.current();
    close(1);
    await expect(resolver.current()).resolves.toMatchObject({ port: 1 });
  });
});

describe('re-scan after a cwd match', () => {
  async function connected() {
    const m = machine();
    m.open(descriptor(1, '/repo'));
    await m.resolver.current();
    return m;
  }

  test('accepts the same root on a new port and announces the change', async () => {
    const { resolver, close, open } = await connected();
    const changed = vi.fn();
    resolver.onTargetChanged(changed);
    close(1);
    open(descriptor(5, '/repo'));

    const next = await resolver.rescan();

    expect(next).toEqual({ port: 5, matchedRoot: '/repo', source: 'cwd-match' });
    expect(changed).toHaveBeenCalledWith(next, { port: 1, matchedRoot: '/repo', source: 'cwd-match' });
    await expect(resolver.current()).resolves.toMatchObject({ port: 5 });
  });

  test('does not announce a re-scan that finds the same port', async () => {
    const { resolver } = await connected();
    const changed = vi.fn();
    resolver.onTargetChanged(changed);
    await resolver.rescan();
    expect(changed).not.toHaveBeenCalled();
  });

  test('holds when only another window is running', async () => {
    const { resolver, close, open } = await connected();
    close(1);
    open(descriptor(2, '/other'));

    await expect(resolver.rescan()).resolves.toBeUndefined();

    expect(resolver.isHeld()).toBe(true);
    await expect(resolver.current()).rejects.toBeInstanceOf(WaitingForWindowError);
    await expect(resolver.current()).rejects.toThrow('Waiting for the VS Code window for /repo to come back');
  });

  test('holds when discovery is ambiguous or finds nothing', async () => {
    const { resolver, close, open } = await connected();
    close(1);
    await expect(resolver.rescan()).resolves.toBeUndefined();
    open(descriptor(2, '/a'));
    open(descriptor(3, '/b'));
    await expect(resolver.rescan()).resolves.toBeUndefined();
    expect(resolver.isHeld()).toBe(true);
  });

  test('a later tool call recovers once the window is back', async () => {
    const { resolver, close, open } = await connected();
    close(1);
    await resolver.rescan();
    open(descriptor(6, '/repo'));

    await expect(resolver.current()).resolves.toMatchObject({ port: 6 });
    expect(resolver.isHeld()).toBe(false);
  });

  test('reconnect ignores the hold and replaces the saved root', async () => {
    const { resolver, close, open } = await connected();
    close(1);
    open(descriptor(2, '/other'));
    await resolver.rescan();

    await expect(resolver.reconnect()).resolves.toMatchObject({ port: 2, source: 'sole-live' });

    expect(resolver.isHeld()).toBe(false);
    open(descriptor(3, '/third'));
    close(2);
    // The saved target is now a sole-live one, so normal discovery applies.
    await expect(resolver.rescan()).resolves.toMatchObject({ port: 3 });
  });
});

describe('re-scan after a sole-live connection', () => {
  test('follows normal discovery', async () => {
    const { resolver, open, close } = machine();
    open(descriptor(2, '/other'));
    await resolver.current();
    close(2);
    open(descriptor(3, '/elsewhere'));
    await expect(resolver.rescan()).resolves.toMatchObject({ port: 3 });
  });

  test('reports the discovery error when nothing is running', async () => {
    const { resolver, open, close } = machine();
    open(descriptor(2, '/other'));
    await resolver.current();
    close(2);
    await expect(resolver.rescan()).resolves.toBeUndefined();
    await expect(resolver.current()).rejects.toBeInstanceOf(NoServerError);
  });
});

test('a fixed --port never changes target', async () => {
  const { resolver, open } = machine({ portFlag: 999 });
  const changed = vi.fn();
  resolver.onTargetChanged(changed);
  await resolver.current();
  open(descriptor(1, '/repo'));
  await expect(resolver.rescan()).resolves.toMatchObject({ port: 999 });
  await expect(resolver.reconnect()).resolves.toMatchObject({ port: 999 });
  expect(changed).not.toHaveBeenCalled();
});

describe('target client', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

  async function client() {
    const m = machine();
    m.open(descriptor(1, '/repo'));
    const transport = { get: vi.fn(), post: vi.fn() };
    const target = createMcpTargetClient(m.resolver, transport);
    await m.resolver.current();
    return { ...m, transport, target };
  }

  test('sends to the saved target', async () => {
    const { target, transport } = await client();
    transport.post.mockResolvedValue({ ok: true });
    await expect(target.post('/create', { a: 1 })).resolves.toEqual({ ok: true });
    expect(transport.post).toHaveBeenCalledWith('/create', expect.objectContaining({ port: 1 }), { a: 1 });
  });

  test('a refused connection re-scans and retries once on the new port', async () => {
    const { target, transport, close, open } = await client();
    transport.post.mockRejectedValueOnce(refused()).mockResolvedValueOnce({ ok: true });
    close(1);
    open(descriptor(5, '/repo'));

    await expect(target.post('/create', {})).resolves.toEqual({ ok: true });

    expect(transport.post).toHaveBeenCalledTimes(2);
    expect(transport.post).toHaveBeenLastCalledWith('/create', expect.objectContaining({ port: 5 }), {});
  });

  test('never retries a second time', async () => {
    const { target, transport, close, open } = await client();
    transport.post.mockRejectedValue(refused());
    close(1);
    open(descriptor(5, '/repo'));

    await expect(target.post('/create', {})).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    expect(transport.post).toHaveBeenCalledTimes(2);
  });

  test('a refused connection with no window back names the window being waited for', async () => {
    const { target, transport, close } = await client();
    transport.post.mockRejectedValue(refused());
    close(1);

    await expect(target.post('/create', {})).rejects.toBeInstanceOf(WaitingForWindowError);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  test('a refused connection with the same port again returns the original error', async () => {
    const { target, transport } = await client();
    transport.get.mockRejectedValue(refused());
    await expect(target.get('/comments')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(transport.get).toHaveBeenCalledTimes(1);
  });

  test('a timeout is not retried but makes the next call re-scan first', async () => {
    const { target, transport, close, open } = await client();
    transport.post.mockRejectedValueOnce(new Error('IPC request timeout')).mockResolvedValueOnce({});

    await expect(target.post('/create', {})).rejects.toThrow('IPC request timeout');
    expect(transport.post).toHaveBeenCalledTimes(1);

    close(1);
    open(descriptor(5, '/repo'));
    await target.post('/create', {});
    expect(transport.post).toHaveBeenLastCalledWith('/create', expect.objectContaining({ port: 5 }), {});
  });

  test('a 409 marks the target stale', async () => {
    const { target, transport, close, open } = await client();
    transport.post.mockRejectedValueOnce(new IpcHttpError('wrong window', 409)).mockResolvedValueOnce({});

    await expect(target.post('/reply', {})).rejects.toThrow('wrong window');
    close(1);
    open(descriptor(5, '/repo'));
    await target.post('/reply', {});

    expect(transport.post).toHaveBeenLastCalledWith('/reply', expect.objectContaining({ port: 5 }), {});
  });

  test('an ordinary error response does not trigger a re-scan', async () => {
    const { target, transport, close, open } = await client();
    transport.post.mockRejectedValueOnce(new IpcHttpError('Unknown thread', 404)).mockResolvedValueOnce({});

    await expect(target.post('/reply', {})).rejects.toThrow('Unknown thread');
    close(1);
    open(descriptor(5, '/repo'));
    await target.post('/reply', {});

    expect(transport.post).toHaveBeenLastCalledWith('/reply', expect.objectContaining({ port: 1 }), {});
  });
});
