export type AgentKind = 'claude' | 'codex';

export interface AgentSession {
    agent: AgentKind;
    sessionId: string;
    label: string;
    cwd: string;
    socketPath?: string;
    token?: string;
    pid?: number;
    registeredAt: string;
    lastSeenAt: string;
    recency?: number;
}

export class AgentRoster {
    private readonly sessions = new Map<string, AgentSession>();

    register(input: Omit<AgentSession, 'registeredAt' | 'lastSeenAt'>, now = new Date()): AgentSession {
        const old = this.sessions.get(input.sessionId);
        const stamp = now.toISOString();
        const session = { ...input, registeredAt: old?.registeredAt ?? stamp, lastSeenAt: stamp };
        this.sessions.set(session.sessionId, session);
        return session;
    }

    remove(sessionId: string): void { this.sessions.delete(sessionId); }
    get(sessionId: string | undefined): AgentSession | undefined { return sessionId ? this.sessions.get(sessionId) : undefined; }
    list(): AgentSession[] {
        return [...this.sessions.values()].sort((a, b) =>
            (b.recency ?? Date.parse(b.lastSeenAt)) - (a.recency ?? Date.parse(a.lastSeenAt)));
    }
}

export function resolveBinding(sessions: AgentSession[], boundId: string | undefined): AgentSession | undefined {
    const bound = boundId ? sessions.find(s => s.sessionId === boundId) : undefined;
    return bound ?? (sessions.length === 1 ? sessions[0] : undefined);
}

/** Extract the owning Codex thread from metadata attached to an MCP tool call. */
export function codexThreadIdFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
    const direct = meta?.threadId;
    if (typeof direct === 'string' && direct.length > 0) return direct;

    const turn = meta?.['x-codex-turn-metadata'];
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return undefined;
    const fields = turn as Record<string, unknown>;
    const nested = fields.thread_id ?? fields.session_id;
    return typeof nested === 'string' && nested.length > 0 ? nested : undefined;
}

/**
 * Claude's private messaging socket is named after the owning Claude process.
 * Accept the local socket roots used by Claude Code on macOS/Linux/Termux, but
 * do not accept an arbitrary path containing a numeric filename.
 */
export function claudePidFromSocketPath(socketPath: string | undefined): number | undefined {
    if (!socketPath) return undefined;
    const match = /^(?:\/(?:private\/)?tmp\/cc-socks(?:-\d+)?|\/run\/user\/\d+\/cc-socks|\/data\/data\/com\.termux\/files\/usr\/tmp\/cc-socks(?:-\d+)?)\/(\d+)\.sock$/.exec(socketPath);
    if (!match) return undefined;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
