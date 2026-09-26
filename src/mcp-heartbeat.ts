import type { ResolveResult } from './ipc-discovery';
import { getIpcJson } from './protocol/client';
import type { TargetResolver } from './mcp-target';

export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface TargetHeartbeatDependencies {
  resolver: Pick<TargetResolver, 'saved' | 'isHeld' | 'rescan'>;
  /** The workspace roots the window on this port reports, or undefined when it did not answer. */
  probe(target: ResolveResult): Promise<string[] | undefined>;
  log(message: string): void;
}

export interface TargetHeartbeat {
  tick(): Promise<void>;
}

/**
 * One health check of the saved window. When it is gone, or another window has
 * taken over its port, re-scan for it. Ticks never overlap, and nothing is
 * logged while the window stays healthy.
 */
export function createTargetHeartbeat(dependencies: TargetHeartbeatDependencies): TargetHeartbeat {
  let running = false;
  let lost = false;

  async function check(): Promise<void> {
    const target = dependencies.resolver.saved();
    // Nothing is saved before the first tool call; a fixed --port never moves.
    if (!target || target.source === 'flag') return;
    if (!dependencies.resolver.isHeld()) {
      const roots = await dependencies.probe(target);
      if (roots && (target.matchedRoot === null || roots.includes(target.matchedRoot))) {
        lost = false;
        return;
      }
    }
    if (!lost) dependencies.log(`Lost the VS Code window on port ${target.port}; re-scanning every minute`);
    lost = true;
    if (await dependencies.resolver.rescan()) lost = false;
  }

  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        await check();
      } catch (error: any) {
        dependencies.log(`Heartbeat failed: ${error?.message ?? error}`);
      } finally {
        running = false;
      }
    },
  };
}

async function probeWorkspaceRoots(target: ResolveResult): Promise<string[] | undefined> {
  try {
    const answer = await getIpcJson<{ workspaceRoots?: unknown }>('/ping', target, 2_000);
    return Array.isArray(answer.workspaceRoots)
      ? answer.workspaceRoots.filter((root): root is string => typeof root === 'string')
      : [];
  } catch {
    return undefined;
  }
}

/** Start the periodic check. The timer is unref'd so it never keeps the process alive. */
export function startTargetHeartbeat(
  resolver: TargetHeartbeatDependencies['resolver'],
  log: (message: string) => void,
): void {
  const heartbeat = createTargetHeartbeat({ resolver, probe: probeWorkspaceRoots, log });
  setInterval(() => void heartbeat.tick(), HEARTBEAT_INTERVAL_MS).unref();
}
