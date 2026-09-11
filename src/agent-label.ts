import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const MAX_LABEL_LENGTH = 80;

export function normalizeAgentLabel(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const label = value.replace(/\s+/g, ' ').trim();
    if (!label) return undefined;
    return label.length <= MAX_LABEL_LENGTH ? label : `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

export function claudeSessionLabel(
    pid: number | undefined,
    sessionId: string,
    home = os.homedir(),
): string | undefined {
    if (!pid) return undefined;
    try {
        const entry = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), 'utf8'));
        if (entry.sessionId !== sessionId) return undefined;
        return normalizeAgentLabel(entry.name);
    } catch {
        return undefined;
    }
}

export function codexSessionLabel(
    sessionId: string,
    home = os.homedir(),
    runSqlite: typeof execFileSync = execFileSync,
): string | undefined {
    // The validation makes interpolating the identifier into this read-only
    // query safe even if a non-Codex client calls the registration tool.
    if (!/^[0-9a-z-]+$/.test(sessionId)) return undefined;
    const database = path.join(home, '.codex', 'state_5.sqlite');
    if (!fs.existsSync(database)) return undefined;
    try {
        const query = `SELECT COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(first_user_message, '')) FROM threads WHERE id = '${sessionId}' LIMIT 1`;
        const output = runSqlite('sqlite3', ['-readonly', database, query], {
            encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return normalizeAgentLabel(output);
    } catch {
        // sqlite3 is not guaranteed to be installed; registration still works
        // with its short-ID fallback when title lookup is unavailable.
        return undefined;
    }
}
