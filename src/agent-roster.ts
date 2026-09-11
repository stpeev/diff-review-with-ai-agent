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
